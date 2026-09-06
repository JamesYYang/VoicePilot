import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { ASR_MODEL, ASR_PARAMETERS } from './config.js';

/**
 * 百炼实时语音识别的一次会话。跑在**主进程**——API Key 只在这里出现，
 * 渲染进程永远拿不到明文（PRD §5.8）。
 *
 * 本类是 spike/lib/asr.js 里 StreamingAsr 的移植，协议部分保持一致，
 * 另补了三件 spike 里缺失、但产品必须有东西：
 *
 *   1. **全程的 close / error 监听**。原实现只把 ws.on('error') 用在 open 之前的
 *      race 里，握手成功之后的断连根本捕不到，只能干等到超时 —— 用户看到的就是
 *      「卡住了没反应」。这里全程监听，断连立刻上报。
 *   2. **backpressure 可见**。暴露 bufferedBytes，供发送队列决定要不要丢帧。
 *   3. **错误分类**。限流（Throttling.RateQuota）、密钥无效（401/403）、网络断连、
 *      服务端报错要分开：限流要退避重试，密钥错重试一百次也没用。
 *
 * 交互时序（官方文档）：
 *   连接 → run-task → [task-started] → 持续发二进制音频 + 收 result-generated
 *        → finish-task → 继续收 result-generated → [task-finished] → 关闭
 */

const DEFAULT_TIMEOUTS = {
  handshake: 15000, // 等 ws open
  taskStarted: 15000, // 等 task-started
  taskFinished: 20000, // 等 task-finished，与 PRD §4.3 的「最长等 20 秒」对齐
};

/**
 * 把服务端错误归成四类，交给状态机决定怎么收敛。
 * 判据来自实测：限流错误码形如 Throttling.RateQuota，握手失败是 401/403。
 */
function classifyError(code = '', message = '') {
  const s = `${code} ${message}`;
  if (/throttl|rate.?quota|429|too.?many/i.test(s)) return 'throttling';
  if (/401|403|unauthorized|forbidden|invalid.?api.?key/i.test(s)) return 'key';
  if (/enotfound|econnrefused|etimedout|econnreset|eai_again|network/i.test(s)) return 'network';
  return 'asr';
}

/** 服务端主动拒绝/要求稍后重试的关闭码 → 按限流处理 */
function closeCodeMeansThrottling(code) {
  return code >= 1008 && code <= 1013;
}

export class AsrSession {
  #apiKey;
  #workspaceId;
  #model;
  #parameters;
  #input;
  #timeouts;
  #handlers;

  #ws = null;
  #taskId = null;
  #state = 'idle'; // idle | starting | streaming | stopping | closed
  #settled = null;
  #closedByUs = false;

  constructor({
    apiKey,
    workspaceId,
    model = ASR_MODEL,
    parameters = ASR_PARAMETERS,
    input = {},
    timeouts = {},
    onResult,
    onLifecycle,
    onError,
    onClosed,
  }) {
    if (!apiKey) throw new Error('缺少 DASHSCOPE_API_KEY');
    if (!workspaceId) throw new Error('缺少 DASHSCOPE_WORKSPACE_ID');

    this.#apiKey = apiKey;
    this.#workspaceId = workspaceId;
    this.#model = model;
    this.#parameters = parameters;
    this.#input = input;
    this.#timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
    this.#handlers = { onResult, onLifecycle, onError, onClosed };
  }

  get state() {
    return this.#state;
  }

  get taskId() {
    return this.#taskId;
  }

  /** 尚未发出的字节数。发送队列据此判断要不要丢帧。 */
  get bufferedBytes() {
    return this.#ws?.bufferedAmount ?? 0;
  }

  get isOpen() {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  /**
   * 建连并等到 task-started。
   * 返回后才可以开始送音频。
   */
  async start() {
    if (this.#state !== 'idle') throw new Error(`状态 ${this.#state} 下不能重新开始`);
    this.#state = 'starting';
    this.#taskId = randomUUID();

    const ws = new WebSocket(`wss://${this.#workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`, {
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        'X-DashScope-WorkSpace': this.#workspaceId,
        'user-agent': 'voicepilot-desktop/0.1',
      },
    });
    this.#ws = ws;

    let resolveStarted;
    let resolveFinished;
    let rejectFailed;
    const startedPromise = new Promise((r) => (resolveStarted = r));
    const finishedPromise = new Promise((r) => (resolveFinished = r));
    const failedPromise = new Promise((_, rej) => (rejectFailed = rej));
    // race 中落败的 promise 不该冒泡成 unhandled rejection
    failedPromise.catch(() => {});
    // stop() 等的是「成功收尾或失败」两者之一，不能只等 task-finished ——
    // 那个 promise 在 task-failed 时永远不会 resolve。
    this.#settled = Promise.race([
      finishedPromise.then(() => 'finished'),
      failedPromise.catch(() => 'failed'),
    ]);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return; // 非 JSON 帧忽略
      }

      const event = msg?.header?.event;
      const recvAtMs = Date.now();

      if (event === 'task-started') {
        resolveStarted();
        this.#handlers.onLifecycle?.({ type: 'task-started', recvAtMs });
      } else if (event === 'result-generated') {
        const s = msg.payload?.output?.sentence ?? {};
        // 心跳与「无文本无字」的空事件必须过滤：句首标记与静音段都会产生它们，
        // 留着只会虚增中间更新次数，让延迟统计失真（spike 里已踩过）。
        if (s.heartbeat) return;
        if (!s.text && !s.words?.length) return;
        this.#handlers.onResult?.({
          recvAtMs,
          text: s.text ?? '',
          sentenceEnd: s.sentence_end === true,
          sentenceId: s.sentence_id ?? null,
          beginTime: s.begin_time ?? null,
          endTime: s.end_time ?? null,
          words: s.words ?? [],
        });
      } else if (event === 'task-finished') {
        resolveFinished();
        this.#handlers.onLifecycle?.({ type: 'task-finished', recvAtMs });
      } else if (event === 'task-failed') {
        const code = msg.header?.error_code ?? '';
        const message = msg.header?.error_message ?? '';
        const err = { kind: classifyError(code, message), code, message };
        this.#handlers.onError?.(err);
        rejectFailed(new Error(`[${code}] ${message}`));
      }
    });

    // 全程监听，不只是握手阶段。握手后的断连同样要走这里。
    ws.on('error', (e) => {
      const message = e?.message ?? String(e);
      // 握手阶段（starting）的错误会被下面的 race 捕获并抛出；
      // 已经开始推流之后才出错的，必须主动上报，否则状态机会一直等下去。
      if (this.#state === 'starting') return;
      this.#handlers.onError?.({ kind: classifyError('', message), code: 'WS_ERROR', message });
    });

    ws.on('close', (code, reason) => {
      if (this.#closedByUs) return;
      // 非我们主动关闭 → 要么断网，要么服务端把我们踢了（限流时常见）
      const kind = closeCodeMeansThrottling(code) ? 'throttling' : 'network';
      this.#handlers.onClosed?.({ kind, code, reason: reason?.toString('utf8') ?? '' });
    });

    const openError = new Promise((_, rej) =>
      ws.once('error', (e) => rej({ kind: classifyError('', e?.message ?? ''), message: e?.message }))
    );

    await withTimeout(
      Promise.race([new Promise((r) => ws.on('open', r)), openError]),
      this.#timeouts.handshake,
      'WebSocket 握手超时'
    ).catch((e) => {
      this.#teardown();
      throw e;
    });

    ws.send(
      JSON.stringify({
        header: { action: 'run-task', task_id: this.#taskId, streaming: 'duplex' },
        payload: {
          task_group: 'audio',
          task: 'asr',
          function: 'recognition',
          model: this.#model,
          input: this.#input,
          parameters: this.#parameters,
        },
      })
    );

    await withTimeout(
      Promise.race([startedPromise, failedPromise]),
      this.#timeouts.taskStarted,
      '等待 task-started 超时'
    ).catch((e) => {
      this.#teardown();
      throw e;
    });

    this.#state = 'streaming';
  }

  /**
   * 送一帧音频。
   *
   * @returns {{ok: boolean, sentAtMs: number, bufferedBytes: number}}
   *   sentAtMs 在 ws.send() **之前**取，与 spike 的 PacedPlayback 同口径 ——
   *   延迟埋点靠它把「音频位置」映射回「发送时刻」。
   */
  sendAudio(chunk) {
    const sentAtMs = Date.now();
    if (this.#state !== 'streaming' || !this.isOpen) {
      return { ok: false, sentAtMs, bufferedBytes: this.bufferedBytes };
    }
    this.#ws.send(chunk, { binary: true });
    return { ok: true, sentAtMs, bufferedBytes: this.bufferedBytes };
  }

  /**
   * 停止收尾：发 finish-task 并等 task-finished。
   * 超时不抛错 —— PRD §4.3 要求超时后强制回收并**保留已识别内容**。
   *
   * @returns {{truncated: boolean}} truncated 为 true 表示没等到 task-finished
   */
  async stop() {
    if (this.#state !== 'streaming') return { truncated: false };
    this.#state = 'stopping';

    if (this.isOpen) {
      this.#ws.send(
        JSON.stringify({
          header: { action: 'finish-task', task_id: this.#taskId, streaming: 'duplex' },
          payload: { input: {} },
        })
      );
    }

    // 等 task-finished，但不必死等：task-failed 一到就立刻收手，
    // 否则失败场景要多卡 20 秒才进 reviewing，用户会以为应用卡了。
    const outcome = await withTimeout(this.#settled, this.#timeouts.taskFinished, '')
      .then(() => 'finished')
      .catch(() => 'timeout');

    this.#teardown();
    return { truncated: outcome !== 'finished' };
  }

  /** 强制清理。用于取消、退避重试前丢弃旧会话。 */
  abort() {
    this.#teardown();
  }

  #teardown() {
    const ws = this.#ws;
    this.#ws = null;
    this.#state = 'closed';
    if (!ws) return;

    // 置上标志再 close，避免自己的关闭动作被 close 处理器当成「非预期断连」
    this.#closedByUs = true;
    ws.removeAllListeners('message');
    ws.removeAllListeners('error');
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }
}

/**
 * 给 promise 加超时。
 * race 一有结果就清定时器，别留下跑不完的哨兵；落败的 guard 自己吞掉 rejection。
 */
function withTimeout(promise, ms, message) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || '超时')), ms);
  });
  guard.catch(() => {});
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}
