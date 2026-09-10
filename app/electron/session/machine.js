import { loadCredentials } from '../asr/config.js';
import { AsrSession } from '../asr/session.js';
import { AudioQueue } from './audio-queue.js';
import { LatencyMetrics, formatSummary } from '../telemetry/metrics.js';
import { t } from '../../shared/i18n/index.js';
import { getCurrentLocale } from '../locale.js';
import { toTraditional } from '../i18n/zh-convert.js';

/**
 * 听写会话状态机（PRD §4.1）。跑在主进程，是唯一的状态源；渲染进程只负责显示。
 *
 *   idle ──toggle──▶ warming ──task-started──▶ listening ──toggle──▶ draining
 *                        │                                              │
 *                    再按一次取消                               task-finished / 20s 超时
 *                        ▼                                              ▼
 *                       idle                                        reviewing ──复制/关闭──▶ idle
 *
 * 几个刻意的取舍：
 *
 * - **不预热会话**。百炼按 usage.duration 计费，静音也计费，常驻空会话白烧钱。
 *   会话在按下快捷键时才建立（PRD §4.1）。
 * - **音频从第一帧就开始收**，但由队列缓冲，task-started 后才真正发出去。
 *   这样既不浪费钱，又不会吞掉用户开口的第一个字。队列上限同时兼任
 *   「只留最近 3 秒」的策略，不需要额外的 flush 逻辑。
 * - **重连用新会话而不是续会话**。服务端的时间基准（begin_time/end_time）是相对
 *   task 的，换 task_id 就要重置埋点原点，否则延迟数字会整体错位。
 * - **文本归渲染进程所有**。这里只转发事件。这样限流重试、断连恢复都不需要
 *   搬运文本，「已识别文本不丢失」（A7）天然成立。
 */

const DRAIN_INTERVAL_MS = 50;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];
const MAX_ATTEMPTS = 3;

export class SessionMachine {
  #emit;
  #queue = new AudioQueue();
  #session = null;
  #metrics = null;
  #creds = null;
  #state = 'idle';
  #notice = null;
  #attempt = 0;
  #truncated = false;
  #drainTimer = null;
  #retryTimer = null;
  #lastSeqSent = 0;
  #lastDurationMs = null;
  #backoffMs = BACKOFF_MS;
  #createSession;
  #fixedCreds = null;

  /**
   * @param emit          向渲染进程推送
   * @param maxAttempts   限流/断连的最大重试次数
   * @param backoffMs     退避阶梯
   * @param createSession 会话工厂。**只为自测注入**：状态机的三条异常收敛路径
   *                      （取消、超时、限流重试）用假会话才能确定性地触发，
   *                      否则要真的打满百炼并发才行。生产留空即用 AsrSession。
   */
  constructor({
    emit,
    maxAttempts = MAX_ATTEMPTS,
    backoffMs = BACKOFF_MS,
    createSession,
    credentials,
  }) {
    this.#emit = emit;
    this.maxAttempts = maxAttempts;
    this.#backoffMs = backoffMs;
    this.#createSession = createSession ?? ((opts) => new AsrSession(opts));
    // 显式给了凭据就不再去读 .env —— 自测不该依赖开发者机器上的 .env 是否存在
    this.#fixedCreds = credentials ?? null;
  }

  get state() {
    return this.#state;
  }

  /** 最近一次会话的时长（毫秒），无结果时为 null。供 vp:history/save 落库。 */
  get lastDurationMs() {
    return this.#lastDurationMs;
  }

  /** 渲染进程挂载时拉一次当前状态，避免错过它启动之前的那次状态广播。 */
  getSnapshot() {
    return { state: this.#state, notice: this.#notice, truncated: this.#truncated };
  }

  // ------------------------------------------------------------ 外部输入

  /** 快捷键。五态下的语义各不相同。 */
  async toggle() {
    if (this.#state === 'idle') return this.start();
    if (this.#state === 'warming') return this.#cancel();
    if (this.#state === 'listening') return this.#stop();
    // draining 期间忽略：此时正在等服务端收尾，再按一次会丢掉收尾结果
    if (this.#state === 'draining') return { ignored: true };
    if (this.#state === 'reviewing') return this.#dismiss();
    return { ignored: true };
  }

  async start() {
    try {
      this.#creds = this.#fixedCreds ?? loadCredentials();
    } catch (e) {
      // 密钥拿不到是最常见的失败。明确提示，并且**不进 warming** ——
      // 否则用户会看到「准备中」转圈，却永远等不到结果。
      this.#emit('vp:error', { kind: 'key', message: e.message, preserveText: true });
      return { ok: false, kind: 'key', message: e.message };
    }

    this.#metrics = new LatencyMetrics();
    this.#metrics.markToggle();
    this.#attempt = 0;
    this.#truncated = false;
    this.#notice = null;
    this.#lastDurationMs = null;
    this.#queue.clear();
    this.#lastSeqSent = 0;
    this.#setState('warming');

    this.#startDrainTimer();
    await this.#openSession();
    return { ok: this.#state !== 'idle' };
  }

  /** 渲染进程送来的音频帧。无论当前处于哪个状态都收 —— warming 期间靠它缓冲。 */
  onAudioFrame({ seq, cumSamples }, pcm) {
    if (this.#state === 'idle' || this.#state === 'reviewing') return;
    this.#queue.push({ seq, cumSamples, pcm: Buffer.from(pcm) });
    // 立刻尝试发送，别等下一次轮询
    this.#pump();
  }

  /** 渲染进程首帧绘制完成（epoch ms），用于「快捷键 → 上屏」这项延迟。 */
  markPainted(atEpochMs) {
    this.#metrics?.markPainted(atEpochMs);
  }

  /**
   * 采集侧失败（麦克风被占用 / 未授权）。由渲染进程上报后收敛。
   * 走的是 warming 的取消路径 —— 会话还没送出音频，直接撤掉，不用等收尾。
   */
  abortByCaptureError(message) {
    this.#emit('vp:error', { kind: 'mic', message, preserveText: true });
    void this.#cancel();
  }

  // ------------------------------------------------------------ 内部流程

  async #openSession() {
    const session = this.#createSession({
      ...this.#creds,
      onResult: (ev) => {
        this.#metrics?.onResult(ev);
        void toTraditional(ev.text).then((text) => {
          this.#emit('vp:asr/partial', { ...ev, text });
        });
      },
      onError: (e) => this.#onSessionError(e),
      onClosed: (e) => this.#onSessionClosed(e),
    });
    this.#session = session;

    try {
      await session.start();
    } catch (e) {
      // start() 内部失败（握手/超时/task-failed）都落到这里
      this.#onSessionError({ kind: 'network', code: 'START_FAILED', message: e.message });
      return;
    }

    if (this.#session !== session) return; // 已被取消或替换
    this.#notice = null;
    this.#setState('listening');
    // 立刻把 warming 期间攒下的音频推上去（PRD §4.1）
    this.#pump();
  }

  async #cancel() {
    // warming 期间再按一次 = 取消。不要等 task-started 再走正常停止流程：
    // 那要白等最多 15 秒，而且白白烧掉一段计费时长。
    this.#session?.abort();
    this.#session = null;
    this.#queue.clear();
    this.#stopDrainTimer();
    this.#clearRetry();
    this.#setState('idle');
  }

  async #stop() {
    this.#metrics?.markStop();
    this.#stopDrainTimer();
    this.#clearRetry();
    this.#setState('draining');

    const session = this.#session;
    this.#session = null;

    if (!session) {
      this.#toReviewing();
      return;
    }

    // 超时不抛错：PRD §4.3 要求超时强制回收并保留已识别内容
    const { truncated } = await session.stop();
    this.#truncated = truncated;
    this.#toReviewing();
  }

  #toReviewing() {
    this.#metrics?.markReviewing();
    this.#setState('reviewing');

    const summary = this.#metrics?.finish();
    if (!summary) return;

    this.#lastDurationMs = summary.dictationDurationMs ?? null;

    console.log(`[延迟] ${formatSummary(summary)}`);
    this.#emit('vp:metrics', summary);

    // 一条结果都没有的会话不值得落盘（多半是启动即失败或被取消），
    // 否则每次误触快捷键都会在 userData 里留一个空 json。
    if (summary.samples.results > 0) {
      this.#metrics.save(summary).catch((e) => console.error(`[延迟] 落盘失败：${e.message}`));
    }
  }

  #dismiss() {
    this.#queue.clear();
    this.#setState('idle');
  }

  // ------------------------------------------------------------ 错误处理

  #onSessionError(e) {
    if (this.#state === 'idle' || this.#state === 'draining' || this.#state === 'reviewing') return;

    if (e.kind === 'throttling') {
      // 限流统一用翻译文案，不把服务端英文原文（e.message）混进 retryExhausted
      // 模板 —— 否则会出现「Service unavailable，已重试 2 次仍未成功」。原文进日志。
      if (e.message) console.warn(`[会话] throttling 服务端原文：${e.message}`);
      this.#scheduleRetry('throttling', t(getCurrentLocale(), 'machine.busy'));
      return;
    }

    // 其余错误（密钥无效、服务端报错）重试没有意义 —— 直接收敛，保留文本
    this.#emit('vp:error', { kind: e.kind, message: e.message, preserveText: true });
    this.#failToReviewing();
  }

  #onSessionClosed(e) {
    if (this.#state === 'idle' || this.#state === 'draining' || this.#state === 'reviewing') return;
    // 非我们主动关闭的连接断开：断网，或被服务端踢掉（限流时常见）
    this.#scheduleRetry(
      e.kind,
      e.kind === 'throttling'
        ? t(getCurrentLocale(), 'machine.busy')
        : t(getCurrentLocale(), 'machine.disconnected')
    );
  }

  #scheduleRetry(kind, message) {
    if (this.#attempt >= this.maxAttempts) {
      this.#emit('vp:error', {
        kind,
        message: t(getCurrentLocale(), 'machine.retryExhausted', { message, attempt: this.#attempt }),
        preserveText: true,
      });
      this.#failToReviewing();
      return;
    }

    this.#session?.abort();
    this.#session = null;

    const base = this.#backoffMs[Math.min(this.#attempt, this.#backoffMs.length - 1)];
    const jitter = 1 + (Math.random() * 0.4 - 0.2); // ±20%，避免多台机器同节奏重试
    const delay = Math.round(base * jitter);
    this.#attempt += 1;
    this.#notice = { kind, message, attempt: this.#attempt, maxAttempts: this.maxAttempts };

    console.warn(`[会话] ${kind}：${delay}ms 后第 ${this.#attempt}/${this.maxAttempts} 次重试`);
    this.#emit('vp:state', this.getSnapshot());

    // 退避期间**不停止采集**：渲染进程照常送帧，队列上限自动只留最近 3 秒，
    // 重连成功后立刻就能接上，不会漏掉用户正在说的话。
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      // 新会话 = 新 task_id，服务端时间基准从头开始，埋点映射必须跟着重置
      this.#metrics?.resetSegment();
      void this.#openSession();
    }, delay);
  }

  #failToReviewing() {
    this.#session?.abort();
    this.#session = null;
    this.#stopDrainTimer();
    this.#metrics?.markStop();
    this.#toReviewing();
  }

  // ------------------------------------------------------------ 发送循环

  /**
   * 把队列里的帧尽量发出去。
   *
   * 触发时机有三个：收到新帧时、会话刚就绪时、以及定时轮询。
   * 前两个不能省 —— 只靠 50ms 轮询的话，warming 缓冲的音频要等最多 50ms
   * 才发得出去，而 PRD §4.1 要求 task-started 一到就立刻 flush；
   * 每帧也要白等最多 50ms 才上路，直接吃进延迟预算。
   * 轮询只作拥塞后的兜底：积压时队列里的帧要等 ws 缓冲降下来才有机会发。
   */
  #pump() {
    const session = this.#session;
    if (!session || session.state !== 'streaming') return;

    const { sent, lastSeq } = this.#queue.drain(session, ({ cumSamples, batchSamples, sentAtMs }) => {
      this.#metrics?.onSend({ cumSamples, batchSamples, sentAtMs });
    });

    // 回执供渲染进程做二级背压（未确认的帧数过多就丢新帧，防止 IPC 队列无界增长）
    if (sent > 0 && lastSeq > this.#lastSeqSent) {
      this.#lastSeqSent = lastSeq;
      this.#emit('vp:audio/ack', { seq: lastSeq, pending: this.#queue.length });
    }
  }

  #startDrainTimer() {
    this.#stopDrainTimer();
    this.#drainTimer = setInterval(() => this.#pump(), DRAIN_INTERVAL_MS);
  }

  #stopDrainTimer() {
    if (this.#drainTimer !== null) clearInterval(this.#drainTimer);
    this.#drainTimer = null;
  }

  #clearRetry() {
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  #setState(state) {
    this.#state = state;
    this.#emit('vp:state', this.getSnapshot());
  }
}
