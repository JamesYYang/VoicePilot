import { app } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 延迟埋点（验收标准 A3，目标见 PRD §6）。
 *
 * 难点在于两侧时间基准不同：服务端回传的 begin_time / end_time 是**相对任务起点**
 * 的音频毫秒数，而我们要算的是「这段音频发出去之后，过了多久才看到结果」。
 * 离线回放时 spike 有 PacedPlayback 的 sendLog 可查，实时麦克风没有，得自己维护。
 *
 * 所以这里维护一条环形 sendLog：记录每个音频位置是**什么时候发出去的**。
 * 收到结果时反查。三个容易错的地方：
 *
 *   1. 原点必须在「第一个真正送进 ws 的帧」锁定，不是「第一帧采集」。
 *      warming 期间会缓冲，握手完成前采集的帧可能整段丢掉；用采集起点当原点，
 *      首字延迟会凭空多出被丢掉的那段。原点错了的表现是首字从 ~600ms 跳到
 *      900ms+ 甚至变负数。
 *   2. sentAtMs 必须在 ws.send() **之前**取（与 spike 的 PacedPlayback 同口径），
 *      否则把发送本身的耗时算进了延迟。
 *   3. 跟随延迟取「每个事件 max(word.end_time)」，**不能**取「每个字首次出现」——
 *      草稿的 begin_time 会漂移，同一个字会被反复当成新字，
 *      实测会把 P50 从 ~200ms 抬到 5404ms（spike/probe.js 里明确警告过）。
 */

const SEND_LOG_MAX = 3000; // 约 5 分钟（100ms 一批）。再久也用不上，且不能无界增长（A8）
const OUTPUT_RATE = 16000;

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

export class LatencyMetrics {
  #sendLog = [];
  #originSamples = null;
  #firstWordMs = null;
  #followMs = [];
  #finalMs = [];
  #toggleAt = null;
  #paintedAt = null;
  #stopAt = null;
  #reviewingAt = null;
  #resultCount = 0;
  #finalCount = 0;
  /** sentAtOf 命中「早于日志起点」的次数。>0 值得查，说明原点偏了 */
  #clamped = 0;

  /** 会话开始（快捷键按下）。 */
  markToggle(atMs = Date.now()) {
    this.#toggleAt = atMs;
  }

  /** 渲染进程首帧绘制完成。由 vp:ui/painted 回报，单位是 epoch ms（与 Date.now 可比）。 */
  markPainted(atEpochMs) {
    if (this.#paintedAt === null) this.#paintedAt = atEpochMs;
  }

  markStop(atMs = Date.now()) {
    this.#stopAt = atMs;
  }

  markReviewing(atMs = Date.now()) {
    if (this.#reviewingAt === null) this.#reviewingAt = atMs;
  }

  /**
   * 记录一帧音频「在什么音频位置、于何时发出」。
   * 由发送队列在 ws.send() 成功后调用。
   *
   * @param cumSamples   累计样本数（**含**这一帧），由渲染进程随帧送来
   * @param batchSamples 这一帧的样本数
   * @param sentAtMs     ws.send() **之前**取的 Date.now()
   */
  onSend({ cumSamples, batchSamples, sentAtMs }) {
    // 记的是这一帧的**起始**位置，与 spike 的 PacedPlayback 同口径
    // （那边是 `audioMs = i * chunkMs`）。用结束位置会引入固定 100ms 偏移。
    const cumBefore = cumSamples - batchSamples;

    // 原点滞后锁定到「第一个真正送出去的帧之前」。
    // 之后丢帧也不用平移：cumSamples 是累计值，丢帧只让相邻 audioMs 间隔变大，
    // 不会破坏「音频位置 ↔ 发送时刻」的对应关系。
    if (this.#originSamples === null) this.#originSamples = cumBefore;

    const audioMs = (cumBefore - this.#originSamples) / (OUTPUT_RATE / 1000);
    this.#sendLog.push({ audioMs, sentAtMs });
    if (this.#sendLog.length > SEND_LOG_MAX) this.#sendLog.shift();
  }

  /**
   * 音频位置 → 该位置被发出的时刻。
   *
   * 目标位置早于日志起点时钳到 log[0]（与 spike 一致，保证与基线可比），
   * 但会计数 —— 正常应该一次都不发生，频繁发生说明埋点原点错了。
   */
  sentAtOf(audioMs) {
    const log = this.#sendLog;
    if (log.length === 0) return null;
    // 倒序找最后一项 audioMs <= 目标值
    for (let i = log.length - 1; i >= 0; i--) {
      if (log[i].audioMs <= audioMs) {
        return log[i].sentAtMs + (audioMs - log[i].audioMs);
      }
    }
    this.#clamped += 1;
    return log[0].sentAtMs;
  }

  /**
   * 重连后开启新的会话段。
   *
   * 服务端的时间基准（begin_time / end_time）是**相对 task** 的，换 task_id
   * 就从 0 重新开始；而本地的 cumSamples 一直在涨。不重置的话，新会话报回来的
   * 小时间戳会被映射到旧会话的发送时刻上，延迟数字直接失去意义。
   */
  resetSegment() {
    this.#originSamples = null;
    this.#sendLog.length = 0;
  }

  /** 收到一条识别结果。结构与 AsrSession 的 onResult 一致。 */
  onResult(ev) {
    this.#resultCount += 1;

    const words = ev.words ?? [];

    // 1) 首字：第一个带字的事件，取首字的 begin_time
    if (this.#firstWordMs === null && words.length > 0) {
      const sent = this.sentAtOf(words[0].begin_time);
      if (sent !== null) this.#firstWordMs = ev.recvAtMs - sent;
    }

    // 2) 跟随：整个事件里最后一个字的 end_time（不能用「每字首次出现」）
    if (words.length > 0) {
      let lastEnd = -Infinity;
      for (const w of words) if (w.end_time != null) lastEnd = Math.max(lastEnd, w.end_time);
      if (lastEnd !== -Infinity) {
        const sent = this.sentAtOf(lastEnd);
        if (sent !== null) this.#followMs.push(ev.recvAtMs - sent);
      }
    }

    // 3) 句尾定稿
    if (ev.sentenceEnd) {
      this.#finalCount += 1;
      const endMs =
        ev.endTime ?? (words.length > 0 ? words[words.length - 1].end_time : null);
      if (endMs != null) {
        const sent = this.sentAtOf(endMs);
        if (sent !== null) this.#finalMs.push(ev.recvAtMs - sent);
      }
    }
  }

  /** 会话结束，产出与 PRD §6 五行表对齐的摘要。 */
  finish() {
    const follow = [...this.#followMs].sort((a, b) => a - b);
    const final = [...this.#finalMs].sort((a, b) => a - b);

    return {
      at: new Date().toISOString(),
      samples: {
        results: this.#resultCount,
        finals: this.#finalCount,
        // 原点健康的会话应当为 0。非 0 意味着上面的延迟数字不可信。
        outOfRangeLookups: this.#clamped,
        sendLogEntries: this.#sendLog.length,
      },
      // PRD §6 五行
      hotkeyToBarMs: this.#toggleAt !== null && this.#paintedAt !== null
        ? this.#paintedAt - this.#toggleAt
        : null, // 目标 <100
      firstWordMs: this.#firstWordMs, // 目标 <800
      followP50Ms: percentile(follow, 50), // 目标 <250
      followP90Ms: percentile(follow, 90),
      sentenceFinalP50Ms: percentile(final, 50), // 目标 <1200
      sentenceFinalP90Ms: percentile(final, 90),
      stopToCopyableMs:
        this.#stopAt !== null && this.#reviewingAt !== null
          ? this.#reviewingAt - this.#stopAt
          : null, // 目标 <1500
      dictationDurationMs:
        this.#toggleAt !== null && this.#stopAt !== null
          ? this.#stopAt - this.#toggleAt
          : null, // 会话时长（快捷键按下 → 松开），供历史落库
    };
  }

  /** 落盘到 userData/metrics/，便于事后填进 PRD §6 与跨机器对比。 */
  async save(summary = this.finish()) {
    const dir = join(app.getPath('userData'), 'metrics');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await writeFile(file, JSON.stringify(summary, null, 2));
    return file;
  }
}

/** 把摘要打成一行，直接贴进 PRD 的表格或聊天窗口。 */
export function formatSummary(s) {
  const ms = (v) => (v === null || v === undefined ? '—' : `${Math.round(v)} ms`);
  return (
    `快捷键→上屏 ${ms(s.hotkeyToBarMs)} | 首字 ${ms(s.firstWordMs)} | ` +
    `跟随 P50 ${ms(s.followP50Ms)} | 句尾定稿 P50 ${ms(s.sentenceFinalP50Ms)} | ` +
    `松开→可复制 ${ms(s.stopToCopyableMs)}  ` +
    `(结果 ${s.samples.results} 条 / 定稿 ${s.samples.finals} 句)`
  );
}
