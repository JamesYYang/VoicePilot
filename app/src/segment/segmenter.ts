/**
 * 分段判据：把「哪些定稿句该另起一段」从 App.tsx 里抽出来，做成可单测的纯逻辑。
 *
 * gap（句间停顿）的来源不固定：百炼的 sentence 对象在不同模型上带不带
 * begin_time/end_time 并不一致。所以两条路都支持：
 *   1. 服务端时间戳齐全 → cur.beginTime - prev.endTime
 *   2. 任一缺失 → 「本地接收时间差」：上一句定稿事件到达本地后，到下一句第一个
 *      中间结果到达本地之间的毫秒数。
 * 两者都是「停顿越长、gap 越大」的单调代理，配合自适应阈值够用。
 */

export interface PartialLike {
  sentenceEnd: boolean;
  beginTime: number | null;
  endTime: number | null;
  /** 本事件到达渲染进程的本地时间（epoch ms，始终有） */
  recvAtMs: number;
}

export const PARA_BREAK_MIN_MS = 1200;
export const PARA_BREAK_MULT = 2.5;
export const GAP_WINDOW = 10;

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function breakThresholdMs(gaps: number[]): number {
  return Math.max(median(gaps) * PARA_BREAK_MULT, PARA_BREAK_MIN_MS);
}

export class ParagraphSegmenter {
  #prevEndServer: number | null = null;
  #prevEndRecv: number | null = null;
  #curStartRecv: number | null = null;
  #awaitingStart = false;
  #gaps: number[] = [];

  /** 喂入每个 partial 事件；只有句尾定稿（sentenceEnd）返回非 null。 */
  offer(e: PartialLike): { paraBreak: boolean; gap: number } | null {
    if (this.#awaitingStart) {
      // 上一句刚定稿，这一条就是下一句的第一个事件 → 记下它的到达时间
      this.#curStartRecv = e.recvAtMs;
      this.#awaitingStart = false;
    }
    if (!e.sentenceEnd) return null;

    let gap = 0;
    if (e.beginTime != null && this.#prevEndServer != null) {
      gap = e.beginTime - this.#prevEndServer;
    } else if (this.#prevEndRecv != null && this.#curStartRecv != null) {
      gap = this.#curStartRecv - this.#prevEndRecv;
    }
    if (gap > 0) {
      this.#gaps.push(gap);
      if (this.#gaps.length > GAP_WINDOW) this.#gaps.shift();
    }
    const paraBreak = gap > 0 && gap >= breakThresholdMs(this.#gaps);

    this.#prevEndServer = e.endTime ?? null;
    this.#prevEndRecv = e.recvAtMs;
    this.#awaitingStart = true;
    this.#curStartRecv = null;
    return { paraBreak, gap };
  }

  reset(): void {
    this.#prevEndServer = null;
    this.#prevEndRecv = null;
    this.#curStartRecv = null;
    this.#awaitingStart = false;
    this.#gaps = [];
  }
}
