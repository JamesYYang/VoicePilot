/**
 * 重采样 worklet：把麦克风任意原生采样率，用**小数比线性插值**降到 16000 Hz。
 *
 * 为什么必须有这个文件（PRD §5.2）：
 * 现有浏览器 demo 用的是整数抽取 —— `ratio = Math.round(ctx.sampleRate / 16000)`，
 * 然后每 ratio 个样本取 1 个。它只在采样率是 16000 的整数倍时才正确：
 *
 *   48000 → ratio 3 → 输出 16000 Hz  正确
 *   44100 → ratio 3 → 输出 14700 Hz  慢 8.1%   ← macOS CoreAudio 最常见
 *   24000 → ratio 2 → 输出 12000 Hz  慢 33%
 *
 * 而服务端硬编码 sample_rate: 16000 且不校验（spike/lib/asr.js），于是音频被
 * 以 0.92× 的速度喂进去 —— 表现就是「越说越滞后，只能识别到几秒前说的话」。
 * 2026-09-05 领导在 MacBook + Chrome 上的反馈与此高度吻合。
 *
 * 这里的做法是：读游标按**小数**步长 ratio = 输入率/16000 在输入流上滑动，
 * 每个输出样本取左右两个输入样本做线性插值。44100 → ratio = 2.75625，
 * 输出严格 16000 Hz，不做任何取整。
 *
 * ⚠️ 本文件以字符串形式被 `?raw` 导入、包成 Blob URL 交给
 * audioWorklet.addModule()，因此**不能**用 import / export，也不能引用外部符号。
 * worklet 作用域内可用的全局只有 sampleRate / currentTime / currentFrame 等。
 */

const OUTPUT_RATE = 16000;

/** 100ms 一批：1600 样本 = 3200 字节。PRD §5.2 第 4 条（百炼官方对新模型的示例值）。 */
const BATCH_SAMPLES = 1600;

class ResamplerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // 每个输出样本之间，读游标要前进多少个**输入**样本。小数，不是整数。
    this.ratio = sampleRate / OUTPUT_RATE;

    // 跨块插值需要往前多看 1 个样本，所以每块保留 ceil(ratio)+1 个历史样本。
    this.tailSize = Math.ceil(this.ratio) + 1;
    this.tail = new Float32Array(this.tailSize);

    // 读游标，坐标系是「本块拼上 tail 之后的合并数组」的下标。
    // 起点 = tailSize，也就是本块第一个样本；tail 占下标 0..tailSize-1。
    this.pos = this.tailSize;

    this.buf = new Float32Array(BATCH_SAMPLES);
    this.bufLen = 0;

    // 掉帧检测。渲染线程一旦没赶上截止时间，输入流就会出现空洞 ——
    // 那种空洞在波形上就是一段静音，听不出来，但 ASR 会直接漏字。
    // 靠 currentFrame 的跳变来抓：正常情况下两次 process() 之间恰好前进
    // 一个渲染量子（128 帧），跳变更大说明中间有帧没送到我们手里。
    this.lastFrame = -1;
    this.glitches = 0;
    this.lostFrames = 0;

    // AudioWorkletProcessor 没有停止钩子，停止前由主线程发一条 flush 消息，
    // 否则最后不足 100ms 的零头会丢掉，总样本数对不上墙钟。
    this.port.onmessage = (e) => {
      if (e.data?.type === 'flush') this.#flushPartial();
    };
  }

  /**
   * @param {Float32Array[][]} inputs
   * @returns {boolean} 返回 true 让节点保持存活
   */
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;

    const n = input.length;
    const K = this.tailSize;

    if (this.lastFrame >= 0) {
      const delta = currentFrame - this.lastFrame;
      if (delta > n) {
        this.glitches += 1;
        this.lostFrames += delta - n;
      }
    }
    this.lastFrame = currentFrame;

    // 合并数组：下标 0..K-1 是上一块的尾巴，K..K+n-1 是本块。
    // 下标 K-1 即「上一个输入样本」，跨块插值靠它接得上。
    const combined = new Float32Array(K + n);
    combined.set(this.tail, 0);
    combined.set(input, K);

    // 插值要读 combined[i] 与 combined[i+1]，所以游标最多到 K+n-1（不含）。
    const limit = K + n - 1;
    let p = this.pos;

    while (p < limit) {
      // p 恒 >= 0：初值是 K(>=1)，每轮迭代后进位到 [K-1, K-1+ratio)，也恒 >= 0。
      const i = p | 0;
      const f = p - i;
      const a = combined[i];
      this.buf[this.bufLen++] = a + (combined[i + 1] - a) * f;

      if (this.bufLen === BATCH_SAMPLES) this.#flush();

      p += this.ratio;
    }

    // 下一块的坐标系会整体左移 n，所以这里减掉 n 把游标搬过去。
    // 差值 < 1 个输入样本，不丢也不重复 —— 长期字节率因此严格等于 32000 B/s。
    this.pos = p - n;

    // 保留合并数组最后 K 个样本给下一块。
    this.tail.set(combined.subarray(n));

    return true;
  }

  /** 发走一整批，剩下的零头留给下一批。 */
  #flush() {
    this.#post(this.buf);
    this.buf = new Float32Array(BATCH_SAMPLES);
    this.bufLen = 0;
  }

  /** 停止时把不足一批的零头也发走，否则总样本数会少不到 100ms 的量。 */
  #flushPartial() {
    if (this.bufLen > 0) {
      this.#post(this.buf.subarray(0, this.bufLen));
      this.buf = new Float32Array(BATCH_SAMPLES);
      this.bufLen = 0;
    }
  }

  /**
   * @param {Float32Array} pcm
   *
   * 带上音频时钟时间戳 t。主线程据此算「这批音频本该在什么时刻被处理」，
   * 与实际处理时刻之差就是本地处理滞后（lag），滞后**持续增长**才是
   * 「越说越滞后」的特征 —— 固定几十毫秒的滞后只是图延迟，无害。
   */
  #post(pcm) {
    this.port.postMessage(
      {
        t: currentTime,
        pcm,
        glitches: this.glitches,
        lostFrames: this.lostFrames,
      },
      [pcm.buffer]
    );
  }
}

registerProcessor('vp-resampler', ResamplerProcessor);
