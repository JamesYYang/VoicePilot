import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { PacedPlayback, sleep } from './wav.js';

const DEFAULT_MODEL = 'paraformer-realtime-v2';

/**
 * 百炼 Paraformer 实时语音识别 WebSocket 客户端。
 *
 * 交互时序（官方文档）：
 *   连接 → run-task → [task-started] → 持续发二进制音频 + 收 result-generated
 *        → finish-task → 继续收 result-generated → [task-finished] → 关闭
 *
 * 每个收到的事件都会打上本地接收时刻（recvAtMs），这是延迟测量的基础。
 */
export class ParaformerClient {
  #apiKey;
  #workspaceId;
  #model;

  constructor({ apiKey, workspaceId, model = DEFAULT_MODEL }) {
    if (!apiKey) throw new Error('缺少 DASHSCOPE_API_KEY');
    if (!workspaceId) throw new Error('缺少 DASHSCOPE_WORKSPACE_ID');

    this.#apiKey = apiKey;
    this.#workspaceId = workspaceId;
    this.#model = model;
  }

  #buildUrl() {
    return `wss://${this.#workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`;
  }

  /**
   * 跑一次完整识别。
   *
   * @param pcm      16kHz/16bit/单声道 PCM 数据
   * @param params   传给 run-task 的 parameters（覆盖默认值）
   * @param chunkMs  音频分块毫秒数
   * @param onChunk  每发出一块音频后的回调，用于进度显示
   * @returns 事件流与关键时间点
   */
  async recognize({ pcm, params = {}, chunkMs = 100, onChunk } = {}) {
    const taskId = randomUUID();
    const url = this.#buildUrl();
    const durationMs = pcm.length / 32; // 16000Hz × 2字节/ms

    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        'X-DashScope-WorkSpace': this.#workspaceId,
        'user-agent': 'voicepilot-spike/0.1',
      },
    });

    const events = [];
    let taskStarted = null; // 收到 task-started 的本地时刻
    let taskFailed = null;
    let lastUsage = null;

    // 用 Promise 包装一次性事件（task-started / task-finished / 失败）
    let resolveStarted;
    let resolveFinished;
    let rejectFailed;
    const startedPromise = new Promise((r) => (resolveStarted = r));
    const finishedPromise = new Promise((r) => (resolveFinished = r));
    const failedPromise = new Promise((_, rej) => (rejectFailed = rej));

    ws.on('message', (raw) => {
      const text = raw.toString('utf8');

      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return; // 非 JSON 帧忽略
      }

      const event = msg?.header?.event;
      const recvAtMs = Date.now();

      if (event === 'task-started') {
        taskStarted = recvAtMs;
        resolveStarted();
      } else if (event === 'result-generated') {
        const sentence = msg.payload?.output?.sentence ?? {};
        if (msg.payload?.output?.usage) lastUsage = msg.payload.output.usage;
        events.push({
          recvAtMs,
          text: sentence.text ?? '',
          sentenceEnd: sentence.sentence_end === true,
          heartbeat: sentence.heartbeat === true,
          beginTime: sentence.begin_time ?? null,
          endTime: sentence.end_time ?? null,
          words: sentence.words ?? [],
        });
      } else if (event === 'task-finished') {
        resolveFinished();
      } else if (event === 'task-failed') {
        taskFailed = {
          code: msg.header.error_code,
          message: msg.header.error_message,
        };
        rejectFailed(new Error(`ASR 任务失败 [${taskFailed.code}]: ${taskFailed.message}`));
      }
    });

    const openError = new Promise((_, rej) => ws.on('error', rej));

    // 握手完成。失败通常意味着 key 无效或 workspace id 不对（返回 401/403）
    await Promise.race([new Promise((r) => ws.on('open', r)), openError]);

    ws.send(
      JSON.stringify({
        header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
        payload: {
          task_group: 'audio',
          task: 'asr',
          function: 'recognition',
          model: this.#model,
          input: {},
          parameters: { format: 'pcm', sample_rate: 16000, ...params },
        },
      })
    );

    // 超时保护：服务端对无响应任务有超时（文档示例为 23s），这里留足余量
    await withTimeout(startedPromise, 15000, '等待 task-started 超时，检查 API Key 与 Workspace ID');

    // 发送音频与接收结果是全双工并行：playback 期间事件持续到达。
    // playback 同时记录每块的真实发送时刻，延迟计算依赖它。
    const playback = new PacedPlayback(pcm, { chunkMs, sampleRate: 16000 });

    await Promise.race([
      playback.play((chunk, audioMs, i) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true });
        onChunk?.(i, playback.chunkCount);
      }),
      failedPromise,
      withTimeout(sleep(1e9), Math.max(60000, durationMs * 3), '发送音频整体超时'),
    ]);

    ws.send(
      JSON.stringify({
        header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
        payload: { input: {} },
      })
    );

    await Promise.race([finishedPromise, failedPromise, withTimeout(sleep(1e9), 20000, '等待 task-finished 超时')]);

    if (ws.readyState === WebSocket.OPEN) ws.close();

    return { events, taskStarted, playback, usage: lastUsage, taskFailed, model: this.#model };
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(message)), ms);
    }),
  ]);
}
