import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { PacedPlayback, sleep } from './wav.js';

const DEFAULT_MODEL = 'paraformer-realtime-v2';

function buildUrl(workspaceId) {
  return `wss://${workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`;
}

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
    return buildUrl(this.#workspaceId);
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
    failedPromise.catch(() => {}); // race 中落败时不该冒泡成 unhandled rejection

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

    await withTimeout(
      Promise.race([
        playback.play((chunk, audioMs, i) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true });
          onChunk?.(i, playback.chunkCount);
        }),
        failedPromise,
      ]),
      Math.max(60000, durationMs * 3),
      '发送音频整体超时'
    );

    ws.send(
      JSON.stringify({
        header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
        payload: { input: {} },
      })
    );

    await withTimeout(
      Promise.race([finishedPromise, failedPromise]),
      20000,
      '等待 task-finished 超时'
    );

    if (ws.readyState === WebSocket.OPEN) ws.close();

    return { events, taskStarted, playback, usage: lastUsage, taskFailed, model: this.#model };
  }
}

/**
 * 流式会话：由调用方手动控制「开始 → 持续送音频 → 停止」。
 *
 * 与 ParaformerClient.recognize() 的区别在于音频来源——recognize() 喂的是
 * 一段已知的 PCM，而这里是实时麦克风，何时开始与结束由用户按键决定。
 * 用于 demo 的浏览器转发层。
 */
export class StreamingParaformer {
  #apiKey;
  #workspaceId;
  #model;
  #handlers;
  #ws = null;
  #taskId = null;
  #state = 'idle'; // idle | starting | streaming | stopping
  #finishedPromise = null;

  constructor({ apiKey, workspaceId, model = DEFAULT_MODEL, onResult, onDone, onError }) {
    if (!apiKey) throw new Error('缺少 DASHSCOPE_API_KEY');
    if (!workspaceId) throw new Error('缺少 DASHSCOPE_WORKSPACE_ID');

    this.#apiKey = apiKey;
    this.#workspaceId = workspaceId;
    this.#model = model;
    this.#handlers = { onResult, onDone, onError };
  }

  get state() {
    return this.#state;
  }

  async start(params = {}) {
    if (this.#state !== 'idle') throw new Error(`状态 ${this.#state} 下不能重新开始`);
    this.#state = 'starting';
    this.#taskId = randomUUID();

    const ws = new WebSocket(buildUrl(this.#workspaceId), {
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        'X-DashScope-WorkSpace': this.#workspaceId,
        'user-agent': 'voicepilot-demo/0.1',
      },
    });
    this.#ws = ws;

    let resolveStarted;
    let resolveFinished;
    let rejectFailed;
    const startedPromise = new Promise((r) => (resolveStarted = r));
    const finishedPromise = new Promise((r) => (resolveFinished = r));
    const failedPromise = new Promise((_, rej) => (rejectFailed = rej));
    failedPromise.catch(() => {}); // race 中落败时不该冒泡成 unhandled rejection
    this.#finishedPromise = finishedPromise;

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8'));
      const event = msg?.header?.event;

      if (event === 'task-started') {
        resolveStarted();
      } else if (event === 'result-generated') {
        const s = msg.payload?.output?.sentence ?? {};
        if (s.heartbeat) return;
        this.#handlers.onResult?.({ text: s.text ?? '', sentenceEnd: s.sentence_end === true });
      } else if (event === 'task-finished') {
        resolveFinished();
      } else if (event === 'task-failed') {
        const err = new Error(`[${msg.header.error_code}] ${msg.header.error_message}`);
        this.#handlers.onError?.(err);
        rejectFailed(err);
      }
    });

    const openError = new Promise((_, rej) => ws.on('error', rej));
    await Promise.race([new Promise((r) => ws.on('open', r)), openError]);

    ws.send(
      JSON.stringify({
        header: { action: 'run-task', task_id: this.#taskId, streaming: 'duplex' },
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

    await withTimeout(
      Promise.race([startedPromise, failedPromise]),
      15000,
      '等待 task-started 超时'
    );
    this.#state = 'streaming';
  }

  sendAudio(chunk) {
    if (this.#state === 'streaming' && this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(chunk, { binary: true });
    }
  }

  async stop() {
    if (this.#state !== 'streaming') return;
    this.#state = 'stopping';

    this.#ws.send(
      JSON.stringify({
        header: { action: 'finish-task', task_id: this.#taskId, streaming: 'duplex' },
        payload: { input: {} },
      })
    );

    // 超时也要继续清理，不能把连接挂在半空
    await withTimeout(this.#finishedPromise, 20000, '等待 task-finished 超时').catch(() => {});

    this.#cleanup();
    this.#handlers.onDone?.();
  }

  /** 浏览器断开时强制清理，避免百炼侧连接泄漏 */
  abort() {
    this.#cleanup();
  }

  #cleanup() {
    if (this.#ws) {
      this.#ws.removeAllListeners('message');
      if (this.#ws.readyState === WebSocket.OPEN || this.#ws.readyState === WebSocket.CONNECTING) {
        this.#ws.close();
      }
      this.#ws = null;
    }
    this.#state = 'idle';
  }
}

/**
 * 给 promise 加超时。两处细节：
 * - race 一旦分出胜负就清掉定时器，别留下一个跑不完的哨兵 sleep
 * - 落败的 guard 自己吞掉 rejection，避免在 race 中落败时冒泡成 unhandled
 */
function withTimeout(promise, ms, message) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  guard.catch(() => {});
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}
