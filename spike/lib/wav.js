import { readFileSync } from 'node:fs';

/**
 * 解析 WAV 文件，返回 PCM 数据与格式信息。
 *
 * 严格校验为 16kHz / 16bit / 单声道 PCM —— 这是百炼 Paraformer 实时识别
 * 的输入约定，也是本 spike 做延迟测量的前提：我们按「音频毫秒数 == 真实
 * 毫秒数」的假设回放音频，格式不符会让整个延迟计算失去意义。
 */
export function readWav(path) {
  const buffer = readFileSync(path);

  if (buffer.length < 12) throw new Error(`${path}: 文件过小，不是合法的 WAV`);
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`${path}: 缺少 RIFF 头`);
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${path}: 缺少 WAVE 标识`);

  let fmt = null;
  let data = null;
  let offset = 12;

  // 遍历 chunk 而非硬编码 44 字节偏移：录音软件常插入 LIST/fact 等额外 chunk
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === 'fmt ' && size >= 16) {
      fmt = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = {
        start: body,
        length: Math.min(size, buffer.length - body),
      };
    }

    // chunk 按偶数字节对齐，长度为奇数时后跟一个填充字节
    offset = body + size + (size % 2);
  }

  if (!fmt) throw new Error(`${path}: 找不到 fmt chunk`);
  if (!data) throw new Error(`${path}: 找不到 data chunk`);

  const problems = [];
  if (fmt.audioFormat !== 1) problems.push(`编码格式 ${fmt.audioFormat} 不是 PCM（应为 1）`);
  if (fmt.channels !== 1) problems.push(`声道数 ${fmt.channels}（应为 1）`);
  if (fmt.sampleRate !== 16000) problems.push(`采样率 ${fmt.sampleRate}Hz（应为 16000）`);
  if (fmt.bitsPerSample !== 16) problems.push(`位深 ${fmt.bitsPerSample}bit（应为 16）`);

  if (problems.length > 0) {
    throw new Error(
      `${path} 格式不符合要求：\n  - ${problems.join('\n  - ')}\n\n` +
        `请用 ffmpeg 转码后重试：\n` +
        `  ffmpeg -i "${path}" -ar 16000 -ac 1 -c:a pcm_s16le "${path.replace(/\.wav$/i, '')}-16k.wav"`
    );
  }

  const pcm = buffer.subarray(data.start, data.start + data.length);
  return { pcm, sampleRate: fmt.sampleRate, durationMs: (pcm.length / 2 / fmt.sampleRate) * 1000 };
}

/**
 * 实时回放器：按真实时间节奏逐块吐出 PCM，并记录每一块的实际发送时刻。
 *
 * 之所以记录「实际」而非「计划」时刻：Windows 上 setTimeout 有 1–15ms 抖动，
 * 累计会漂移。延迟测量必须用真实发送时刻，否则测出来的是我们的调度误差
 * 而不是 ASR 的延迟。
 */
export class PacedPlayback {
  #chunks;
  #chunkMs;
  #sendLog = []; // 每项 { audioMs, sentAtMs }

  constructor(pcm, { chunkMs = 100, sampleRate = 16000 } = {}) {
    this.#chunkMs = chunkMs;
    const bytesPerChunk = Math.round((sampleRate * 2 * chunkMs) / 1000);

    this.#chunks = [];
    for (let i = 0; i < pcm.length; i += bytesPerChunk) {
      this.#chunks.push(pcm.subarray(i, Math.min(i + bytesPerChunk, pcm.length)));
    }
  }

  get chunkCount() {
    return this.#chunks.length;
  }

  get sendLog() {
    return this.#sendLog;
  }

  /**
   * 逐块回放。onChunk 收到 (pcm块, 该块在音频中的起始毫秒, 块索引)。
   * 以真实时间推进，因此总耗时约等于音频时长。
   */
  async play(onChunk) {
    const t0 = Date.now();

    for (let i = 0; i < this.#chunks.length; i++) {
      const audioMs = i * this.#chunkMs;

      // 在发送前记录，使 sendLog 与音频位置严格对应
      this.#sendLog.push({ audioMs, sentAtMs: Date.now() });
      onChunk(this.#chunks[i], audioMs, i);

      if (i === this.#chunks.length - 1) break;

      // 对齐到绝对时刻而非累加间隔，避免漂移累积
      const target = t0 + (i + 1) * this.#chunkMs;
      const wait = target - Date.now();
      if (wait > 0) await sleep(wait);
    }
  }

  /**
   * 把「音频中的毫秒位置」换算成「该音频被发出去的真实时刻」。
   * 用于延迟计算：字在音频中位于 t 毫秒 → 它是在 sentAtOf(t) 被说出去的。
   */
  sentAtOf(audioMs) {
    const log = this.#sendLog;
    if (log.length === 0) return null;

    for (let i = log.length - 1; i >= 0; i--) {
      if (log[i].audioMs <= audioMs) {
        return log[i].sentAtMs + (audioMs - log[i].audioMs);
      }
    }
    return log[0].sentAtMs;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
