import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { CaptureEngine } from './audio/capture';

/**
 * 悬浮条（PRD §4.1 / §5.6）。
 *
 * 两条硬约束贯穿整个组件：
 *
 * 1. **不抢焦点**（A2）。窗口本身 focusable:false，这里再补三条：不调用任何
 *    focus()、不用 autoFocus、不在挂载时做任何会激活窗口的事。显隐一律由
 *    主进程的 showInactive() 控制（见 electron/main.js）。
 * 2. **状态只有一个源头**。听写状态（idle/warming/listening/draining/reviewing）
 *    由主进程的状态机持有，这里只订阅与显示。界面上的「复制」等操作也只是
 *    向主进程发一个 toggle，不自己改状态 —— 否则两边迟早打架。
 *
 * 文本模型沿用浏览器原型里已验证过的那套：committed[] 存定稿句、draft 存
 * 当前草稿，渲染时把 draft 追加在最后一段末尾。定稿与草稿的区分来自服务端
 * 的 sentence_end，分段判据是句间静默 ≥800ms（demo 里实测出来的阈值）。
 */

/** 句间静默超过这个值就另起一段（沿用 demo 实测的判据） */
const PARA_BREAK_MS = 800;
/** 未确认帧数的上限。超了就丢新帧，防止 IPC 队列无界增长（A8） */
const MAX_INFLIGHT = 8;
/**
 * 出错后悬浮条多停留多久。
 *
 * 采集失败时状态机会直接回到 idle，若跟着立刻隐藏，错误提示就一闪而过 ——
 * 用户只看到悬浮条闪了一下，根本不知道发生了什么（A7 要求「明确提示」）。
 * 停留几秒再淡出，同时不阻塞下一次触发（快捷键一来就清掉）。
 */
const ERROR_HOLD_MS = 5000;

/** 悬浮条窗口高度的上下限（与 electron/main.js 的 BAR / BAR_MAX_HEIGHT 对应）。 */
const BAR_MIN_HEIGHT = 148;
const BAR_MAX_HEIGHT = 420;

type SessionState = 'idle' | 'warming' | 'listening' | 'draining' | 'reviewing';

interface Notice {
  kind: string;
  message: string;
  attempt: number;
  maxAttempts: number;
}

interface Snapshot {
  state: SessionState;
  notice: Notice | null;
  truncated: boolean;
}

interface Partial {
  text: string;
  sentenceEnd: boolean;
  beginTime: number | null;
  endTime: number | null;
}

interface Committed {
  text: string;
  paraBreak: boolean;
}

export interface AppProps {
  /** 可注入以便自测（#uitest 路由）。默认用 preload 暴露的真桥。 */
  bridge?: Window['voicepilot'];
  /**
   * 采集源工厂。默认用真引擎；自测注入假的，就可以在没有麦克风的机器上
   * 把「采集 → 上行 → 界面」整条链路跑一遍。
   */
  createCapture?: (onBatch: (pcm: Int16Array) => void) => {
    start: () => Promise<void>;
    stop: () => Promise<void>;
  };
}

export default function App({ bridge, createCapture }: AppProps = {}) {
  const vp = bridge ?? window.voicepilot;

  const [snap, setSnap] = useState<Snapshot>({ state: 'idle', notice: null, truncated: false });
  const [committed, setCommitted] = useState<Committed[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<{ kind: string; message: string } | null>(null);
  const [errorHold, setErrorHold] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [copied, setCopied] = useState(false);

  // 帧序号与未确认计数放在 ref：它们每 100ms 变一次，进 state 会白白重渲染
  const seqRef = useRef(0);
  const cumSamplesRef = useRef(0);
  const ackedSeqRef = useRef(0);
  const droppedRef = useRef(0);
  const lastEndRef = useRef(0);
  const historySavedRef = useRef(false);
  const historyIdRef = useRef<number | null>(null);

  const captureRef = useRef<{ start: () => Promise<void>; stop: () => Promise<void> } | null>(null);
  const errorTimerRef = useRef<number | null>(null);

  /** 出错时展示并停留几秒。悬浮条可能随即回到 idle，不能跟着立刻消失。 */
  const showError = useCallback((e: { kind: string; message: string }) => {
    setError(e);
    setErrorHold(true);
    if (errorTimerRef.current !== null) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = window.setTimeout(() => {
      setErrorHold(false);
      errorTimerRef.current = null;
    }, ERROR_HOLD_MS);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
    setErrorHold(false);
    if (errorTimerRef.current !== null) {
      clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
  }, []);

  const onBatch = useCallback(
    (pcm: Int16Array) => {
      // 二级背压：主进程那边积压了，这里就别再往 IPC 里塞，
      // 否则队列无界增长，10 分钟口述能把内存吃光（A8）。丢帧比卡死好。
      if (seqRef.current - ackedSeqRef.current >= MAX_INFLIGHT) {
        droppedRef.current += 1;
        return;
      }
      seqRef.current += 1;
      cumSamplesRef.current += pcm.length;
      vp.sendAudio(
        { seq: seqRef.current, cumSamples: cumSamplesRef.current },
        new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
      );
    },
    [vp]
  );

  // 采集源只建一次
  useEffect(() => {
    captureRef.current =
      createCapture?.(onBatch) ??
      (() => {
        const engine = new CaptureEngine(() => {}, onBatch);
        return { start: () => engine.start(), stop: () => engine.stop() };
      })();
  }, [createCapture, onBatch]);

  // 订阅主进程广播
  useEffect(() => {
    const offState = vp.onState((s: Snapshot) => {
      setSnap(s);
      if (s.state !== 'idle') clearError();
    });
    const offError = vp.onError((e: { kind: string; message: string }) => showError(e));
    const offAck = vp.onAck((a: { seq: number }) => {
      ackedSeqRef.current = Math.max(ackedSeqRef.current, a.seq);
    });
    const offPartial = vp.onPartial((p: Partial) => {
      if (p.sentenceEnd) {
        // 定稿：整句入列，并据句间静默决定是否另起一段
        const gap = p.beginTime !== null && lastEndRef.current ? p.beginTime - lastEndRef.current : 0;
        setCommitted((prev) => [...prev, { text: p.text, paraBreak: gap >= PARA_BREAK_MS }]);
        setDraft('');
      } else {
        setDraft(p.text);
      }
      if (p.endTime !== null) lastEndRef.current = p.endTime;
    });

    // 挂载时拉一次当前状态：可能错过了渲染进程启动前的那几次广播
    void vp.syncState().then((s: Snapshot) => setSnap(s));

    return () => {
      offState();
      offError();
      offAck();
      offPartial();
    };
  }, [vp, showError, clearError]);

  // 跟随状态启停采集。idle 与 reviewing 都不该继续采集：
  // 前者是没在听写，后者已经停止收音了（PRD §4.1 的 draining 语义）。
  //
  // ⚠️ 只在「活着 ↔ 不活」翻转时才启停，不能把 snap.state 直接放进依赖数组里
  // 再无条件 stop/start：warming → listening 是正常过渡，两者都算「活着」，
  // 一旦在这里 stop 再 start，同一个引擎会被并发启动两次 —— 两个 AudioContext、
  // 两个 worklet 互相踩，表现就是「听不到任何声音 / 一个字都不上屏」。
  const capturingRef = useRef(false);
  useEffect(() => {
    const live = snap.state === 'warming' || snap.state === 'listening';
    if (live === capturingRef.current) return;
    capturingRef.current = live;

    if (!live) {
      void captureRef.current?.stop();
      return;
    }

    void (async () => {
      try {
        await captureRef.current?.start();
      } catch (e) {
        if (!capturingRef.current) return; // 已在报错前切走，不再打扰
        // 采集中止必须上报：主进程不知道 getUserMedia 为什么失败
        const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        vp.captureFailed(message);
        showError({ kind: 'mic', message });
      }
    })();
  }, [snap.state, vp, showError]);

  // 从「未在听写」切到 warming 时重置一次文本，避免上一段残留
  const prevStateRef = useRef<SessionState>('idle');
  useEffect(() => {
    if (prevStateRef.current === 'idle' && snap.state === 'warming') {
      setCommitted([]);
      setDraft('');
      setCopied(false);
      seqRef.current = 0;
      cumSamplesRef.current = 0;
      ackedSeqRef.current = 0;
      droppedRef.current = 0;
      lastEndRef.current = 0;
      historySavedRef.current = false;
      historyIdRef.current = null;

      // 「快捷键 → 上屏」的终点是**真的画出来**的那一刻，所以等一帧再回报。
      // performance.timeOrigin + performance.now() 是 epoch 毫秒，
      // 与主进程的 Date.now() 同基准，两边可以直接相减。
      requestAnimationFrame(() =>
        vp.reportPainted(performance.timeOrigin + performance.now())
      );
    }
    prevStateRef.current = snap.state;
  }, [snap.state]);

  const fullText = useMemo(() => {
    const parts: string[] = [];
    for (const c of committed) {
      parts.push(c.text);
      if (c.paraBreak) parts.push('\n');
    }
    return [...parts, draft].join('');
  }, [committed, draft]);

  // reviewing 时把原文写入历史一次。文本归渲染进程所有，主进程只落库。
  // 每次会话只存一次：historySavedRef 在 warming 时重置。
  useEffect(() => {
    if (snap.state !== 'reviewing') return;
    if (historySavedRef.current) return;
    if (fullText.trim().length === 0) return;
    historySavedRef.current = true;
    void vp.historySave({ text: fullText }).then((r) => {
      historyIdRef.current = r?.id ?? null;
    });
  }, [snap.state, fullText, vp]);

  // 移入时关闭穿透（按钮可点），移出时恢复穿透（不挡住下面的应用）
  useEffect(() => {
    vp.setMousePassthrough(!hovering);
  }, [hovering, vp]);

  // 听写进行中自动滚到底部：这是「实时跟随」的展示，永远该看到最新那句。
  // 停止（reviewing）后不自动滚，让用户自由回翻查看。
  const textRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (snap.state !== 'listening' && snap.state !== 'draining') return;
    const el = textRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [draft, committed, snap.state]);

  // 内容变多/变少时，按需请求主进程调整悬浮条窗口高度（向上生长，有上限）。
  // 用「文本区溢出量」来算：scrollHeight 是内容自然高度，clientHeight 是当前
  // 可见高度，两者之差就是还缺多少空间。窗口长高后 clientHeight 跟着变大，
  // 差值归零即收敛；文字删短后差值为负，窗口自动缩回下限。
  const lastHeightRef = useRef(0);
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    const overflow = el.scrollHeight - el.clientHeight;
    const target = Math.min(
      Math.max(window.innerHeight + overflow, BAR_MIN_HEIGHT),
      BAR_MAX_HEIGHT
    );
    const rounded = Math.round(target);
    if (rounded === lastHeightRef.current) return;
    lastHeightRef.current = rounded;
    vp.resizeBar(rounded);
  }, [draft, committed, snap, error, copied, vp]);

  const paragraphs = useMemo(() => {
    // 按 paraBreak 分组，渲染成段落
    const out: string[][] = [[]];
    for (const c of committed) {
      out[out.length - 1].push(c.text);
      if (c.paraBreak) out.push([]);
    }
    return out;
  }, [committed]);

  const copy = useCallback(async () => {
    const ok = await vp.copy(fullText);
    setCopied(ok);
    if (ok) {
      // PRD §4.3：复制后悬浮条淡出。状态由主进程持有，这里只发一个 toggle
      // （reviewing 下 toggle 的语义就是关闭）。
      void vp.toggle();
      return;
    }
    // 复制失败要**看得见**。静默失败最糟糕：用户以为复制成功了，
    // 切到目标应用一粘贴，出来的是上一次的内容。
    showError({ kind: 'clipboard', message: '复制失败，请重试' });
  }, [fullText, vp]);

  // idle 时什么都不渲染。窗口是透明的，不渲染就等于隐藏。
  // 但出错时即便已回到 idle 也要多停留几秒（errorHold），
  // 否则错误提示一闪而过，用户只看到悬浮条闪了一下（A7）。
  if (snap.state === 'idle' && !errorHold) return null;

  return (
    <div
      data-state={snap.state}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={styles.bar}
    >
      <div style={styles.head}>
        <span style={styles.badge}>{LABEL[snap.state]}</span>
        {snap.notice && (
          <span style={styles.notice}>
            {snap.notice.message}
            {snap.notice.attempt ? `（${snap.notice.attempt}/${snap.notice.maxAttempts} 次重试）` : ''}
          </span>
        )}
      </div>

      {error && <div style={styles.error}>{ERROR_TEXT[error.kind] ?? error.message}</div>}

      <div ref={textRef} style={styles.text} data-testid="text">
        {paragraphs.map((lines, i) => (
          <span key={i}>
            {lines.join('')}
            {i < paragraphs.length - 1 ? '\n' : ''}
          </span>
        ))}
        {draft && <span style={styles.draft}>{draft}</span>}
      </div>

      {snap.state === 'reviewing' && (
        <div style={styles.actions}>
          <button
            style={styles.button}
            onClick={() => {
              void vp.openStudio({ text: fullText, historyId: historyIdRef.current ?? undefined });
              // 悬浮条与主应用不同时出现：润色打开主应用后，悬浮条随即关闭
              void vp.toggle();
            }}
          >
            润色
          </button>
          <button style={styles.button} onClick={copy} disabled={fullText.length === 0}>
            复制
          </button>
          <button style={styles.ghost} onClick={() => void vp.toggle()}>
            关闭
          </button>
          {snap.truncated && <span style={styles.warn}>收尾超时，已保留已识别内容</span>}
        </div>
      )}

      {copied && <div style={styles.hint}>已复制到剪贴板</div>}
    </div>
  );
}

const LABEL: Record<SessionState, string> = {
  warming: '准备中',
  listening: '聆听中',
  draining: '收尾中',
  reviewing: '已停止',
  idle: '',
};

const ERROR_TEXT: Record<string, string> = {
  mic: '麦克风不可用，请检查是否被其他程序占用',
  clipboard: '复制失败，请重试',
  network: '网络连接中断',
  throttling: '服务繁忙，正在重试',
  key: '未获取到授权，请联系管理员',
  asr: '识别服务出错，已保留已识别内容',
};

const styles = {
  bar: {
    // 用 calc 扣掉上下 margin，避免「height:100% + margin」让底部 16px 被窗口裁掉
    height: 'calc(100% - 16px)',
    boxSizing: 'border-box' as const,
    margin: 8,
    padding: '12px 16px',
    borderRadius: 12,
    background: 'rgba(248, 250, 252, 0.96)', // 近白但不刺眼，slate-50 微冷调
    border: '1px solid #e2e8f0',
    boxShadow: '0 2px 16px rgba(15, 23, 42, 0.10)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
    fontSize: 13,
    lineHeight: 1.6,
    color: '#1f2937',
    userSelect: 'none' as const,
    overflow: 'hidden',
  },
  head: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  badge: {
    color: '#1d4ed8',
    background: '#eff6ff',
    padding: '1px 8px',
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: 0.5,
  },
  notice: { color: '#b45309', fontSize: 11 },
  warn: { color: '#b45309', fontSize: 11 },
  error: { color: '#dc2626', fontSize: 11, flexShrink: 0 },
  text: {
    flex: 1,
    minHeight: 0,
    // 文本超出后可滚动查看（悬浮条是固定 560×148 的小窗，长文必然溢出）
    overflowY: 'auto' as const,
    overflowX: 'hidden' as const,
    scrollbarWidth: 'thin' as const, // Firefox；Chromium 的细滚动条见 index.html
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
    userSelect: 'text' as const, // 允许选中复制，否则「查看」形同虚设
  },
  draft: { color: '#9ca3af' },
  actions: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  button: {
    padding: '4px 14px',
    borderRadius: 6,
    border: '1px solid #1d4ed8',
    background: '#1d4ed8',
    color: '#ffffff',
    fontSize: 12,
    cursor: 'pointer' as const,
  },
  ghost: {
    padding: '4px 10px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    background: 'transparent',
    color: '#6b7280',
    fontSize: 12,
    cursor: 'pointer' as const,
  },
  hint: { color: '#6b7280', fontSize: 11, flexShrink: 0 },
} satisfies Record<string, CSSProperties>;
