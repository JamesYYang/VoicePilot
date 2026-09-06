/**
 * 采集引擎 —— M1 spike 的测量主体（PRD §5.2）。
 *
 * 它同时干两件事：
 *   1. 按 PRD §5.2 的正确做法采集并重采样（原生采样率建图 + 小数比插值 + 100ms 合批）
 *   2. 一边跑一边**测量自己**，把三个独立的漂移信号暴露出来给诊断面板
 *
 * ⚠️ 所有判定指标一律用**滑动窗口速率**，不用累计值。
 *
 * 这是 2026-09-06 第一次真机跑完改掉的：累计值会被一个启动常量污染，量出来是
 * 假的。AudioContext.currentTime 要到图真正开始渲染才前进，而 resume() 刚返回时
 * 图往往还没动 —— Windows 实测这个常量就有 32ms，占当时「漂移」读数的全部。
 * 同理，第一批音频要攒满 100ms 才发出，从「第一批到达」开始计时也带常量。
 * 常量无害（不增长），但它会淹没真正要找的**速率差**，所以只看速率。
 *
 * 三个信号指向完全不同的故障：
 *
 *   bytesPerSec  滑动 1 秒的输出字节率，期望 32000 B/s。错在**重采样比**。
 *                老 demo 在 44100 上输出 14700Hz，这里会稳定显示 -8%。
 *                这是最容易被误判成「网络慢」的一类。
 *   graphRate    图时钟速率（currentTime / 墙钟，滑动 3 秒），期望 1.000000。
 *                错在**音频设备时钟**。macOS 上采集设备与输出设备不同源时
 *                （蓝牙麦 + 内置扬声器）两个时钟各走各的，会持续偏移，
 *                且**没有爆音** —— 与 2026-09-05 领导说的
 *                「只能识别到几秒前说的话」完全吻合。这是 macOS 的头号嫌疑。
 *   lagDriftMs   批处理滞后相对起始值的变化。错在**主线程被拖住**。
 *                固定几十毫秒是图延迟，无害；持续增长才是追不上实时。
 */

export const OUTPUT_RATE = 16000;
export const BATCH_MS = 100;

/** 16bit 单声道：16000 样本/秒 × 2 字节 = 32000 B/s。PRD §5.2 第 3 条的断言基准。 */
export const EXPECTED_BYTES_PER_SEC = OUTPUT_RATE * 2;
const EXPECTED_BATCH_SAMPLES = (OUTPUT_RATE * BATCH_MS) / 1000; // 1600

/** 字节率断言容差，PRD §5.2 第 3 条。 */
export const BYTE_RATE_TOLERANCE_PCT = 2;

export interface DeviceInfo {
  label: string;
  /** 设备上报的采样率。与 AudioContext.sampleRate 可能不同（中间还有一层重采样）。 */
  deviceSampleRate: number;
  channels: number;
  /** 这三项必须都是 false，否则拿到的是处理过的音频，不是原始音频。 */
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

export interface CaptureMetrics {
  state: 'idle' | 'starting' | 'running';
  /** AudioContext 实际跑在多少 Hz —— 不指定 sampleRate 由系统决定 */
  nativeSampleRate: number;
  /** 输入样本/输出样本，小数。整数才是 bug（老 demo 的 Math.round） */
  ratio: number;
  device: DeviceInfo | null;
  elapsedMs: number;
  totalSamples: number;
  bytesPerSec: number;
  bytesPerSecDevPct: number;
  batches: number;
  batchesPerSec: number;
  avgBatchSamples: number;
  /** 图时钟速率，滑动 3 秒。1.000000 为正常，偏离即设备时钟与系统时钟不同步 */
  graphRate: number;
  /** 图时钟速率的区间。稳态偏移 → 区间窄；掉帧 → 区间宽 */
  graphRateMin: number;
  graphRateMax: number;
  /** 掉帧次数。**大于 0 就是采集有空洞**，ASR 会漏字；0 则时钟偏移无害 */
  glitches: number;
  /** 掉帧造成的音频缺失时长 */
  lostMs: number;
  /** 以下三项是累计值，含启动常量，只看趋势不用来判定 */
  driftMs: number;
  graphDriftMs: number;
  /** 本地处理滞后相对起始值的变化量。增长 = 追不上实时 */
  lagDriftMs: number;
  lagMs: number;
  baseLatencyMs: number;
  outputLatencyMs: number;
}

interface WorkletMessage {
  /** 音频时钟时间戳（秒），由 worklet 在发这一批时盖的 */
  t: number;
  pcm: Float32Array;
  /** 累计掉帧次数 */
  glitches: number;
  /** 累计丢失的输入帧数（原生采样率下） */
  lostFrames: number;
}

export class CaptureEngine {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private sink: AudioNode | null = null;

  private chunks: Int16Array[] = [];
  private timer: number | null = null;

  private batches = 0;
  private totalSamples = 0;
  /** 滑动窗口：最近 1 秒内收到的批次，用于算实时字节率 */
  private recent: { at: number; samples: number }[] = [];

  /** 采样点：每 200ms 记一次（墙钟, 图时钟），滑动 3 秒算图时钟速率 */
  private clock: { wall: number; ctx: number }[] = [];

  private firstBatchAt = 0;
  private startWall = 0;
  private startCtx = 0;
  private baseLagMs = Number.NaN;
  private lagMs = Number.NaN;

  private glitches = 0;
  private lostFrames = 0;

  /** 图时钟速率的极值。单点读数看不出是稳定偏移还是忽快忽掉帧，得看区间。
   *  初值必须是 ±Infinity：用 NaN 的话 Math.min/max 会永远返回 NaN。 */
  private graphRateMin = Number.POSITIVE_INFINITY;
  private graphRateMax = Number.NEGATIVE_INFINITY;

  private device: DeviceInfo | null = null;
  private state: CaptureMetrics['state'] = 'idle';

  constructor(private readonly onTick: (m: CaptureMetrics) => void) {}

  async start(): Promise<void> {
    if (this.state !== 'idle') return;
    this.state = 'starting';

    // 同一实例会反复 start/stop（诊断面板上点「开始采集」不止一次）。
    // 不清空的话，第二次的 WAV 会混进上一段音频，读数也全是累加值。
    this.chunks = [];
    this.recent = [];
    this.clock = [];
    this.batches = 0;
    this.totalSamples = 0;
    this.firstBatchAt = 0;
    this.baseLagMs = Number.NaN;
    this.lagMs = Number.NaN;
    this.glitches = 0;
    this.lostFrames = 0;
    this.graphRateMin = Number.POSITIVE_INFINITY;
    this.graphRateMax = Number.NEGATIVE_INFINITY;

    // 中途任一步失败都必须把状态放回去，否则引擎永久卡在 starting，
    // 界面上表现为「点了开始没反应，而且再也点不动了」。
    try {
      await this.#open();
    } catch (e) {
      this.state = 'idle';
      await this.#teardown();
      throw e;
    }
  }

  async #open(): Promise<void> {
    // PRD §5.2 第 1 条：**不指定** sampleRate，用设备原生速率建图。
    // 一旦指定 16000，Chromium 会自己重采样一遍，我们就再也看不到真实设备速率，
    // 「44100 → 14700」这类问题会被掩盖。
    // latencyHint:'interactive' 换最小缓冲，听写场景延迟优先于抗抖动。
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;

    // 关掉三项系统处理。ASR 要的是原始音频；AGC 会把音量拉平、NS 会削掉辅音，
    // 两者都会让准确率下降。但浏览器可以忽略这些约束 —— 所以下面要用
    // getSettings() 把**实际生效**的值读回来，不能只信我们传的。
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });

    const settings = this.stream.getAudioTracks()[0].getSettings();
    this.device = {
      label: this.stream.getAudioTracks()[0].label,
      deviceSampleRate: settings.sampleRate ?? 0,
      channels: settings.channelCount ?? 0,
      echoCancellation: Boolean(settings.echoCancellation),
      noiseSuppression: Boolean(settings.noiseSuppression),
      autoGainControl: Boolean(settings.autoGainControl),
    };

    // worklet 源码放在 public/ 下，由 Vite 原样拷进产物，按同源脚本加载。
    //
    // 不走 Blob URL 的原因：Chromium 加载 worklet 模块时查的是 **script-src**
    // （不是 worker-src，实测报错就是这么写的），所以要放行就得给 script-src
    // 加 blob: —— 那等于给整个页面开了口子。发真实文件就无需放宽 CSP。
    //
    // 相对页面 URL 解析，因此 dev（localhost:5173）与打包后（app://）都成立。
    const workletUrl = new URL('resampler-worklet.js', location.href).href;
    await ctx.audioWorklet.addModule(workletUrl);

    const node = new AudioWorkletNode(ctx, 'vp-resampler', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.node = node;
    node.port.onmessage = (e: MessageEvent<WorkletMessage>) => this.#onBatch(e.data);

    this.source = ctx.createMediaStreamSource(this.stream);
    this.source.connect(node);

    // 图必须接到一个水槽才会被拉取：只接 worklet 的图，Chromium 不渲染，
    // currentTime 不前进，整个采集就是死的。
    //
    // 水槽用 MediaStreamAudioDestinationNode，**不用 ctx.destination**。
    // 原因是一个实测出来的坑：接 ctx.destination 时，图由**输出设备**的时钟
    // 拉着跑。2026-09-06 Windows 实测图时钟比系统时钟慢 0.45%（3 分钟累计
    // -858ms），因为采集与回放是两块硬件、两个时钟，两者不同源。
    // MediaStreamAudioDestinationNode 是纯软件水槽，由系统时钟驱动，
    // 不牵扯任何输出硬件 —— 采集速率因此不再受用户插什么耳机/音箱影响。
    // 顺带也省掉了「gain 置 0 防回放」和「无输出设备时图不跑」两个隐患。
    const sink = ctx.createMediaStreamDestination();
    node.connect(sink);
    this.sink = sink;

    // 自动播放策略下 AudioContext 可能是 suspended，点按钮启动通常是 running，
    // 但不保证（尤其是没有用户手势的路径）。
    if (ctx.state === 'suspended') await ctx.resume();

    this.startWall = performance.now();
    this.startCtx = ctx.currentTime;
    this.state = 'running';
    this.timer = window.setInterval(() => this.onTick(this.#snapshot()), 200);
    this.onTick(this.#snapshot());
  }

  /** 拆图、停轨道、关 context。start() 失败时也走这里，避免残留麦克风占用。 */
  async #teardown(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;

    // 先让 worklet 把不足一批的零头发出来，再拆图，否则尾部几十毫秒音频会丢。
    this.node?.port.postMessage({ type: 'flush' });
    await new Promise((r) => setTimeout(r, 60));

    this.source?.disconnect();
    if (this.node) this.node.port.onmessage = null;
    this.node?.disconnect();
    this.node = null;
    this.sink?.disconnect();
    this.sink = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;

    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== 'closed') await ctx.close();
    this.state = 'idle';
  }

  async stop(): Promise<Int16Array> {
    await this.#teardown();

    // 拼接所有批次。总样本数应当 ≈ 时长 × 16000。
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Int16Array(total);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }

  #onBatch({ t, pcm, glitches, lostFrames }: WorkletMessage) {
    const now = performance.now();
    const ctx = this.ctx;
    if (!ctx) return;

    this.glitches = glitches;
    this.lostFrames = lostFrames;

    if (this.firstBatchAt === 0) this.firstBatchAt = now;

    // Float32 [-1,1] → Int16。ASM 链路与 WAV 落盘都吃 Int16。
    const i16 = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    this.chunks.push(i16);
    this.batches += 1;
    this.totalSamples += pcm.length;
    this.recent.push({ at: now, samples: pcm.length });

    // 这批音频在 t 时刻（音频时钟）就该被处理，实际 now 才处理。
    this.lagMs = (ctx.currentTime - t) * 1000;
    if (Number.isNaN(this.baseLagMs)) this.baseLagMs = this.lagMs;
  }

  #snapshot(): CaptureMetrics {
    const now = performance.now();
    const ctx = this.ctx;
    const elapsedMs = this.state === 'running' ? now - this.startWall : 0;

    // 滑动窗口裁剪到最近 1000ms
    const cutoff = now - 1000;
    while (this.recent.length > 0 && this.recent[0].at < cutoff) this.recent.shift();

    // 字节率 = 窗口内样本数 / 窗口跨度。
    // 关键：窗口里**第一批要丢掉**。它代表的是它到达之前的那 100ms 音频，
    // 把它的样本算进分子、却把它的到达时刻当分母起点，速率就被系统性高估
    // （2026-09-06 首次真机实测高估了 3%，正好卡在 2% 容差外，差点误判）。
    // 丢掉第一批后，分子分母对齐的都是「第 2 批到第 N 批之间」的区间。
    let bytesPerSec = 0;
    if (this.recent.length >= 3) {
      const spanSec = (this.recent[this.recent.length - 1].at - this.recent[0].at) / 1000;
      let samples = 0;
      for (let i = 1; i < this.recent.length; i++) samples += this.recent[i].samples;
      if (spanSec > 0) bytesPerSec = (samples * 2) / spanSec;
    }

    // 图时钟速率：滑动 3 秒。累计值含启动常量（Windows 实测 32ms），不能用。
    let graphRate = 1;
    if (ctx && this.state === 'running') {
      this.clock.push({ wall: now, ctx: ctx.currentTime });
      while (this.clock.length > 2 && this.clock[1].wall < now - 3000) this.clock.shift();
      const spanWall = this.clock[this.clock.length - 1].wall - this.clock[0].wall;
      if (spanWall > 500) {
        const spanCtx = this.clock[this.clock.length - 1].ctx - this.clock[0].ctx;
        graphRate = (spanCtx * 1000) / spanWall;
        // 前两秒的窗口太短，速率抖得厉害，等窗口填满再统计极值
        if (spanWall > 2500) {
          this.graphRateMin = Math.min(this.graphRateMin, graphRate);
          this.graphRateMax = Math.max(this.graphRateMax, graphRate);
        }
      }
    }

    // 输出样本数换算成的时长，减去墙钟时长。恒定偏移无害，**增长**才是故障。
    // 以第一批到达时刻为锚：启动阶段的一次性延迟不该算进漂移。
    const producedMs = this.totalSamples / (OUTPUT_RATE / 1000);
    const wallMs = this.firstBatchAt > 0 ? now - this.firstBatchAt : 0;
    const driftMs = producedMs - wallMs;

    let graphDriftMs = 0;
    if (ctx && this.state === 'running') {
      graphDriftMs = (ctx.currentTime - this.startCtx) * 1000 - elapsedMs;
    }

    return {
      state: this.state,
      nativeSampleRate: ctx?.sampleRate ?? 0,
      ratio: ctx ? ctx.sampleRate / OUTPUT_RATE : 0,
      device: this.device,
      elapsedMs,
      totalSamples: this.totalSamples,
      bytesPerSec,
      bytesPerSecDevPct:
        EXPECTED_BYTES_PER_SEC > 0
          ? ((bytesPerSec - EXPECTED_BYTES_PER_SEC) / EXPECTED_BYTES_PER_SEC) * 100
          : 0,
      batches: this.batches,
      batchesPerSec: elapsedMs > 0 ? (this.batches / elapsedMs) * 1000 : 0,
      avgBatchSamples: this.batches > 0 ? this.totalSamples / this.batches : 0,
      graphRate,
      graphRateMin: this.graphRateMin,
      graphRateMax: this.graphRateMax,
      glitches: this.glitches,
      lostMs: this.lostFrames / (ctx?.sampleRate ?? OUTPUT_RATE) * 1000,
      driftMs,
      graphDriftMs,
      lagMs: this.lagMs,
      lagDriftMs: this.lagMs - this.baseLagMs,
      baseLatencyMs: ctx ? ctx.baseLatency * 1000 : 0,
      outputLatencyMs: ctx ? (ctx.outputLatency ?? 0) * 1000 : 0,
    };
  }
}

/** 16kHz / 16bit / 单声道 WAV。落盘后可直接喂给 `npm run probe`。 */
export function encodeWav16k(pcm: Int16Array): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk 长度
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, OUTPUT_RATE, true);
  view.setUint32(28, OUTPUT_RATE * 2, true); // 字节率
  view.setUint16(32, 2, true); // 块对齐
  view.setUint16(34, 16, true); // 位深
  ascii(36, 'data');
  view.setUint32(40, pcm.length * 2, true);

  new Int16Array(buffer, 44).set(pcm);
  return buffer;
}

export { EXPECTED_BATCH_SAMPLES };
