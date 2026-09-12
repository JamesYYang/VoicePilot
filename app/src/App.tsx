import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { CaptureEngine } from './audio/capture';
import { useT } from './i18n';

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
 * 的 sentence_end：每个定稿句单独一行。
 */

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
const BAR_MAX_HEIGHT = 620;

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
  const t = useT();

  const LABEL: Record<SessionState, string> = {
    warming: t('bar.warming'),
    listening: t('bar.listening'),
    draining: t('bar.draining'),
    reviewing: t('bar.reviewing'),
    idle: '',
  };

  const ERROR_TEXT: Record<string, string> = {
    mic: t('bar.err.mic'),
    clipboard: t('bar.err.clipboard'),
    network: t('bar.err.network'),
    throttling: t('bar.err.throttling'),
    key: t('bar.err.key'),
    asr: t('bar.err.asr'),
  };

  const [snap, setSnap] = useState<Snapshot>({ state: 'idle', notice: null, truncated: false });
  const [committed, setCommitted] = useState<Committed[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<{ kind: string; message: string } | null>(null);
  const [errorHold, setErrorHold] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [copied, setCopied] = useState(false);
  // reviewing 态的可编辑面：edited 是唯一真源（进态时由派生文本灌一次），
  // scenes/tones 来自主进程预设通道，scene/tone 只用于 Task 5 的润色请求。
  const [edited, setEdited] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [scenes, setScenes] = useState<Preset[]>([]);
  const [tones, setTones] = useState<Preset[]>([]);
  const [scene, setScene] = useState<Preset | null>(null);
  const [tone, setTone] = useState<Preset | null>(null);
  // 中性提示（「已复制，请手动粘贴」）。**不能**走 error/ERROR_TEXT：
  // ERROR_TEXT[kind] ?? message 里空串不是 nullish，会渲染成一片空白。
  const [hint, setHint] = useState('');

  // 帧序号与未确认计数放在 ref：它们每 100ms 变一次，进 state 会白白重渲染
  const seqRef = useRef(0);
  const cumSamplesRef = useRef(0);
  const ackedSeqRef = useRef(0);
  const droppedRef = useRef(0);
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
        // 每个定稿句单独一行（原「按停顿分自然段」判据已证伪：阈值是
        // 中位数 × 2.5，正常说话永远不会触发，且头 3 句不可能分段）。
        setCommitted((prev) => [
          ...prev,
          { text: p.text, paraBreak: prev.length > 0 },
        ]);
        setDraft('');
      } else {
        setDraft(p.text);
      }
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
      setEdited('');
      setAdvancedOpen(false);
      setHint('');
      seqRef.current = 0;
      cumSamplesRef.current = 0;
      ackedSeqRef.current = 0;
      droppedRef.current = 0;
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
      // paraBreak 语义是「这句之前另起一行」，与 paragraphs 的渲染保持一致：
      // 先补换行、再放本句。反过来（先放后补）会把换行留在句尾，
      // 复制/落库/送润色的文本就和屏幕上看到的布局不一致。
      if (c.paraBreak && parts.length > 0) parts.push('\n');
      parts.push(c.text);
    }
    return [...parts, draft].join('');
  }, [committed, draft]);

  // reviewing 一进来把派生文本灌进编辑区；之后 edited 就是唯一真源。
  // 依赖数组**故意不含 fullText** —— 含进去会在用户每次打字后重跑并覆盖编辑内容。
  useEffect(() => {
    if (snap.state === 'reviewing') setEdited(fullText);
  }, [snap.state]);

  // 拉预设（进入 reviewing 时，且只在没有时拉）。
  useEffect(() => {
    if (snap.state !== 'reviewing' || scenes.length > 0) return;
    void vp.polishPresets().then((p) => {
      setScenes(p.scenes);
      setTones(p.tones);
      setScene(p.scenes.find((x) => x.id === p.defaultSceneId) ?? p.scenes[0] ?? null);
      setTone((prev) => prev ?? p.tones[0] ?? null);
    });
  }, [snap.state, scenes.length, vp]);

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

  // 编辑后的文本回写同一条历史（采纳 / 复制 / 关闭 / 打开应用 时各调一次）。
  // 落库失败不阻塞主流程：界面闭环优先，下次听写会另起一条。
  const persistEdited = useCallback(async () => {
    const id = historyIdRef.current;
    if (id == null) return;
    if (edited.trim().length === 0) return;
    try {
      await vp.historyUpdateText({ id, text: edited });
    } catch {
      /* 落库失败不阻塞主流程 */
    }
  }, [edited, vp]);

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
    // 按 paraBreak 分组，渲染成段落。
    // paraBreak 语义是「这句之前另起一段」，所以要先开新组、再放入本句 ——
    // 反过来（先放后开）会把分段点错位移到句尾，换行跑到段末。
    const out: string[][] = [[]];
    for (const c of committed) {
      if (c.paraBreak && out[out.length - 1].length > 0) out.push([]);
      out[out.length - 1].push(c.text);
    }
    return out;
  }, [committed]);

  const copy = useCallback(async () => {
    await persistEdited();
    const ok = await vp.copy(edited);
    setCopied(ok);
    if (ok) {
      // PRD §4.3：复制后悬浮条淡出。状态由主进程持有，这里只发一个 toggle
      // （reviewing 下 toggle 的语义就是关闭）。
      void vp.toggle();
      return;
    }
    // 复制失败要**看得见**。静默失败最糟糕：用户以为复制成功了，
    // 切到目标应用一粘贴，出来的是上一次的内容。
    showError({ kind: 'clipboard', message: t('bar.err.clipboard') });
  }, [edited, persistEdited, vp, t]);

  /** 「打开应用」：带着编辑后的文本去主应用（悬浮条随即关闭）。 */
  const openApp = useCallback(() => {
    void persistEdited();
    void vp.openStudio({ text: edited, historyId: historyIdRef.current ?? undefined });
    void vp.toggle();
  }, [edited, persistEdited, vp]);

  const close = useCallback(() => {
    void persistEdited();
    void vp.toggle();
  }, [persistEdited, vp]);

  // 本 Task 只做「复制 + 明确提示」；真正的写回（取前台窗口 → 还原焦点 → 粘贴）
  // 是 Plan 2B。用户明确接受这个中间形态：UI 闭环先成立，注入后补。
  const adopt = useCallback(async () => {
    await persistEdited();
    const ok = await vp.copy(edited);
    if (ok) {
      setCopied(true);
      setHint(t('bar.adopt.fallback'));
      return;
    }
    showError({ kind: 'clipboard', message: t('bar.err.clipboard') });
  }, [edited, persistEdited, vp, t]);

  // 悬浮条内润色在 Task 5 实现。本 Task 先把按钮立起来并保证点了有反应：
  // 缺预设时展开折叠区让用户先选。Task 5 会用真正的流式润色替换这段。
  // setHint('')：一次性提示（「已复制，请手动粘贴」）在用户发起新动作时清掉。
  const runPolish = useCallback(() => {
    setHint('');
    setAdvancedOpen(true);
  }, []);

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
            {snap.notice.attempt
              ? t('bar.retry', { attempt: snap.notice.attempt, max: snap.notice.maxAttempts })
              : ''}
          </span>
        )}
      </div>

      {error && <div style={styles.error}>{ERROR_TEXT[error.kind] ?? error.message}</div>}

      {/* reviewing 是可编辑面：textarea 是唯一真源；其余态保持只读展示（A2） */}
      {snap.state === 'reviewing' ? (
        <textarea
          data-testid="bar-editor"
          style={styles.editor}
          value={edited}
          onChange={(e) => setEdited(e.target.value)}
          placeholder={t('polish.placeholder')}
        />
      ) : (
        <div ref={textRef} style={styles.text} data-testid="text">
          {paragraphs.map((lines, i) => (
            <span key={i}>
              {lines.join('')}
              {i < paragraphs.length - 1 ? '\n' : ''}
            </span>
          ))}
          {draft && <span style={styles.draft}>{draft}</span>}
        </div>
      )}

      {snap.state === 'reviewing' && (
        <>
          <div style={styles.actions}>
            <button
              style={styles.button}
              data-testid="bar-polish"
              onClick={runPolish}
              disabled={edited.trim().length === 0}
            >
              {t('bar.polish')}
            </button>
            <button
              style={styles.button}
              data-testid="bar-copy"
              onClick={copy}
              disabled={edited.length === 0}
            >
              {t('bar.copy')}
            </button>
            <button
              style={styles.button}
              data-testid="bar-adopt"
              onClick={adopt}
              disabled={edited.trim().length === 0}
            >
              {t('bar.adopt')}
            </button>
            <button style={styles.ghost} data-testid="bar-open-app" onClick={openApp}>
              {t('bar.openApp')}
            </button>
            <button style={styles.ghost} onClick={() => void close()}>
              {t('bar.close')}
            </button>
            {snap.truncated && <span style={styles.warn}>{t('bar.truncated')}</span>}
          </div>
          <div style={styles.advanced}>
            <button
              style={styles.ghost}
              data-testid="bar-advanced-toggle"
              onClick={() => setAdvancedOpen((v) => !v)}
            >
              {t('bar.advanced')}
            </button>
            {advancedOpen && (
              <>
                <select
                  style={styles.select}
                  data-testid="bar-scene"
                  value={scene?.name ?? ''}
                  onChange={(e) => setScene(scenes.find((p) => p.name === e.target.value) ?? null)}
                >
                  {scenes.map((p) => (
                    <option key={p.id} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <select
                  style={styles.select}
                  data-testid="bar-tone"
                  value={tone?.name ?? ''}
                  onChange={(e) => setTone(tones.find((p) => p.name === e.target.value) ?? null)}
                >
                  {tones.map((p) => (
                    <option key={p.id} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
        </>
      )}

      {copied && <div style={styles.hint}>{t('bar.copied')}</div>}
      {hint && <div style={styles.hint}>{hint}</div>}
    </div>
  );
}

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
  // reviewing 的可编辑区。flex:1 + minHeight:0 才能像 text 一样「撑满剩余空间
  // 并在溢出时自己滚」，否则长文会把按钮行挤出窗口。
  editor: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto' as const,
    resize: 'none' as const,
    border: '1px solid #d1d5db',
    borderRadius: 6,
    padding: 8,
    fontFamily: 'inherit' as const,
    userSelect: 'text' as const,
  },
  actions: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  advanced: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  select: {
    padding: '4px 8px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    background: '#ffffff',
    color: '#111827',
    fontSize: 12,
    outline: 'none',
  },
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
