/**
 * 待发音频队列 + 背压（PRD §5.2 第 5 条）。
 *
 * 为什么必须有：音频是按 1× 实时推的，**一旦落后就永远追不回来**。
 * 网络一卡，ws 的发送缓冲就会堆积；此时如果还老老实实排队，用户看到的
 * 就是「越说越滞后」——屏幕上蹦出来的字对应的是十几秒前说的话。
 * 所以宁可丢掉几个字，也要把输出追回实时。
 *
 * 丢的必须是**最旧**的：丢最新的话，用户当下说的话永远上不了屏，更糟。
 */

/** 约 1 秒音频。超过就暂停发送，等 ws 缓冲降下来 */
const PAUSE_BYTES = 32768;
/** 约 3 秒音频。超过说明已经积压到不可救药，激进清空追平实时 */
const PURGE_BYTES = 98304;

export class AudioQueue {
  /**
   * @param maxFrames 队列硬上限。30 帧 = 3 秒。
   *   必须有上限：没有的话，会话还没建立（warming）或正在退避重试时，
   *   队列会无界增长，10 分钟口述直接吃掉上百 MB（验收标准 A8）。
   */
  constructor({ maxFrames = 30 } = {}) {
    this.maxFrames = maxFrames;
    this.q = [];
    this.dropped = 0;
  }

  get length() {
    return this.q.length;
  }

  /** 积压的字节数，用于决定要不要在渲染进程侧就开始丢帧 */
  get pendingBytes() {
    return this.q.reduce((n, f) => n + f.pcm.byteLength, 0);
  }

  /** @param frame {{seq: number, cumSamples: number, pcm: Buffer}} */
  push(frame) {
    if (this.q.length >= this.maxFrames) {
      this.q.shift(); // 丢最旧
      this.dropped += 1;
    }
    this.q.push(frame);
  }

  clear() {
    this.q.length = 0;
  }

  /**
   * 把队列里的帧发出去。
   *
   * @param session AsrSession
   * @param onSent  每成功发出一帧就回调一次，供埋点记录发送时刻
   * @returns {{sent: number, lastSeq: number, dropped: number}}
   *   lastSeq 用于给渲染进程回执，让它算「有多少帧还没被确认」
   */
  drain(session, onSent) {
    if (!session || session.state !== 'streaming') {
      return { sent: 0, lastSeq: -1, dropped: 0 };
    }

    let sent = 0;
    let lastSeq = -1;
    while (this.q.length > 0 && session.bufferedBytes < PAUSE_BYTES) {
      const f = this.q.shift();
      const r = session.sendAudio(f.pcm);
      if (r.ok) {
        onSent({
          cumSamples: f.cumSamples,
          batchSamples: f.pcm.byteLength / 2,
          sentAtMs: r.sentAtMs,
        });
        sent += 1;
        lastSeq = Math.max(lastSeq, f.seq);
      }
    }

    // 已经积压到 3 秒以上：清队列追平实时。ws 缓冲区里的撤不回来，
    // 但至少别让队列里这份继续变成更大的滞后。
    let purged = 0;
    while (session.bufferedBytes > PURGE_BYTES && this.q.length > 0) {
      this.q.shift();
      purged += 1;
      this.dropped += 1;
    }

    return { sent, lastSeq, dropped: purged };
  }
}

export { PAUSE_BYTES, PURGE_BYTES };
