import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, Ref } from 'react';
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
/** 编辑态编辑区的高度下限：短句时也要给一个舒服的编辑面，不能只剩一行。 */
const BAR_EDITOR_MIN_HEIGHT = 96;
/** 窗口高 = 根内容区 + 18：上下 margin 8×2 与 border 1×2，两者都不计入 scrollHeight/clientHeight。 */
const BAR_MARGINS = 18;

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

  // 采纳写回失败的文案。用显式映射而不是拼 key（`bar.adopt.fail.${reason}`）：
  // t() 对缺 key 的处理是**原样返回 key**，拼串会让漏翻译直接显示成一串英文 key，
  // 而显式映射漏了会落到下面的 ?? 兜底。
  const ADOPT_FAIL_TEXT: Record<string, string> = {
    stale: t('bar.adopt.fail.staleTarget'),
    permission: t('bar.adopt.fail.permission'),
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
  const [scenes, setScenes] = useState<Preset[]>([]);
  const [tones, setTones] = useState<Preset[]>([]);
  const [scene, setScene] = useState<Preset | null>(null);
  const [tone, setTone] = useState<Preset | null>(null);
  // 中性提示（「已复制，请手动粘贴」）。**不能**走 error/ERROR_TEXT：
  // ERROR_TEXT[kind] ?? message 里空串不是 nullish，会渲染成一片空白。
  const [hint, setHint] = useState('');
  // 悬浮条内润色（Task 5）：polishOut 是流式下发的润色结果（下半只读区），
  // polishing 反映请求进行中（按钮禁用 + 文案切换），polishError 存错误信息。
  const [polishOut, setPolishOut] = useState('');
  const [polishing, setPolishing] = useState(false);
  const [polishError, setPolishError] = useState<string | null>(null);

  // 帧序号与未确认计数放在 ref：它们每 100ms 变一次，进 state 会白白重渲染
  const seqRef = useRef(0);
  const cumSamplesRef = useRef(0);
  const ackedSeqRef = useRef(0);
  const droppedRef = useRef(0);
  const historySavedRef = useRef(false);
  const historyIdRef = useRef<number | null>(null);
  // historySave 的 Promise。historyIdRef 是异步填进去的，而「采纳/复制/关闭/打开应用」
  // 可能在这个 Promise 落地前就被点到（几百毫秒内快速点击）。把 Promise 存下来，
  // 读 id 之前 await 一次即可 —— 没有保存待完成时它是 null，await 立即返回，不阻塞。
  const historySaveRef = useRef<Promise<void> | null>(null);

  const captureRef = useRef<{ start: () => Promise<void>; stop: () => Promise<void> } | null>(null);
  const errorTimerRef = useRef<number | null>(null);
  // 上一次已请求的窗口高度（去重用）。声明在这里而不是紧挨高度 effect，
  // 是因为 warming 的复位块也要把它清零：主进程在 idle/warming 已把窗口收回
  // 基础高度，渲染侧若还记着上一段的高值，高度 effect 会因「没变化」短路，
  // 再也请求不回一个合身的高度。
  const lastHeightRef = useRef(0);

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
      setHint('');
      // 上一段的润色结果/状态不能带到这一段
      setPolishOut('');
      setPolishing(false);
      setPolishError(null);
      seqRef.current = 0;
      cumSamplesRef.current = 0;
      ackedSeqRef.current = 0;
      droppedRef.current = 0;
      historySavedRef.current = false;
      historyIdRef.current = null;
      historySaveRef.current = null;
      // 主进程此刻正把窗口收回基础高度（resetBarHeight），清掉去重值，
      // 让高度 effect 能在本段内容需要时重新请求一个合身的高度。
      lastHeightRef.current = 0;

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
    void vp
      .polishPresets()
      .then((p) => {
        setScenes(p.scenes);
        setTones(p.tones);
        setScene(p.scenes.find((x) => x.id === p.defaultSceneId) ?? p.scenes[0] ?? null);
        setTone((prev) => prev ?? p.tones[0] ?? null);
      })
      .catch(() => {
        // 拉预设失败就保持两个下拉为空，不让 rejection 冒成 unhandled。
      });
  }, [snap.state, scenes.length, vp]);

  // 订阅润色流式事件（Task 3 起的通道，target=bar 时会路由到本窗口）。
  // 与 Studio 的 PolishView 同款：delta 逐块追加，done/error 都收尾「进行中」。
  useEffect(() => {
    const offDelta = vp.onPolishDelta(({ text: d }) => setPolishOut((prev) => prev + d));
    const offDone = vp.onPolishDone(() => setPolishing(false));
    const offError = vp.onPolishError(({ message }) => {
      setPolishError(message);
      setPolishing(false);
      // 半成品必须一起清掉：面板查到错误后只显示错误，用户看不到那段残缺文本，
      // 但 effectiveText（采纳/复制取它）仍会落到 polishOut 上，静默把截断结果
      // 当成成品用并回写。宁可让用户重新润色，也不能悄悄用半截文本。
      setPolishOut('');
    });
    return () => {
      offDelta();
      offDone();
      offError();
    };
  }, [vp]);

  // reviewing 时把原文写入历史一次。文本归渲染进程所有，主进程只落库。
  // 每次会话只存一次：historySavedRef 在 warming 时重置。
  useEffect(() => {
    if (snap.state !== 'reviewing') return;
    if (historySavedRef.current) return;
    if (fullText.trim().length === 0) return;
    historySavedRef.current = true;
    historySaveRef.current = vp
      .historySave({ text: fullText })
      .then((r) => {
        historyIdRef.current = r?.id ?? null;
      })
      .catch((e) => {
        // 这条 promise 会被 resolveHistoryId await：若它 reject，异常会穿出
        // persistEdited 并打断 copy / adopt / close 的收尾。所以在这里就地吞掉，
        // id 留空后 resolveHistoryId 返回 null，persistEdited 自行 no-op。
        console.error(`[历史] 保存失败，已跳过本次回写：${e?.message ?? e}`);
      });
  }, [snap.state, fullText, vp]);

  /**
   * 等本会话的历史保存落地并返回 id。
   * historySaveRef 为空（还没发起保存 / 本会话没有文本）时立即返回 null，
   * 所以常规路径不会被拖慢；只有「保存刚发出就被点到」的窄窗口才会等这一趟 IPC。
   */
  const resolveHistoryId = useCallback(async () => {
    await historySaveRef.current;
    return historyIdRef.current;
  }, []);

  // 编辑后的文本回写同一条历史（采纳 / 复制 / 关闭 / 打开应用 时各调一次）。
  // 落库失败不阻塞主流程：界面闭环优先，下次听写会另起一条。
  const persistEdited = useCallback(async () => {
    const id = await resolveHistoryId();
    if (id == null) return;
    if (edited.trim().length === 0) return;
    try {
      await vp.historyUpdateText({ id, text: edited });
    } catch {
      /* 落库失败不阻塞主流程 */
    }
  }, [edited, vp, resolveHistoryId]);

  // 移入时关闭穿透（按钮可点），移出时恢复穿透（不挡住下面的应用）
  useEffect(() => {
    vp.setMousePassthrough(!hovering);
  }, [hovering, vp]);

  // 听写进行中自动滚到底部：这是「实时跟随」的展示，永远该看到最新那句。
  // 停止（reviewing）后不自动滚，让用户自由回翻查看。
  const textRef = useRef<HTMLDivElement | HTMLTextAreaElement>(null);
  // 根节点与编辑区：高度 effect 要用「非内容区占用 + 内容需求」来算窗口高度，
  // 非内容区占用 = root.scrollHeight - contentEl.clientHeight。
  const barRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (snap.state !== 'listening' && snap.state !== 'draining') return;
    const el = textRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [draft, committed, snap.state]);

  // 内容变多/变少时，按需请求主进程调整悬浮条窗口高度（向上生长，有上限）。
  // 按「非内容区占用 + 内容需求」来算：chrome 是除内容元素外的所有行（头、
  // 场景/语气行、按钮行、提示、润色面板）占的高度，其余行都是 flexShrink:0，
  // 窗口变高时这一差值不变，所以算一遍就收敛，不会来回抖。内容元素在 reviewing
  // 是编辑区（给一个舒适下限），其余态是只读文本区。旧的「文本区溢出量」模型不
  // 可用：这些盒子都是 overflow:auto，Chromium 只会报 scrollHeight >= clientHeight，
  // 短句时溢出量是 0 而不是负值，窗口因此从不生长，编辑区被其余行挤成一行高 —— 故废弃。
  useEffect(() => {
    // warming 期间不测：文本刚复位，这一帧量到的是上一轮的残留内容，
    // 会把刚被主进程收回基线高度的窗口重新撑高（见 resetBarHeight）。
    if (snap.state === 'warming') return;
    const root = barRef.current;
    if (!root) return;

    // 内容元素：reviewing 是编辑区，其余态是只读文本区。
    const contentEl = editorRef.current ?? textRef.current;
    const isEditor = !!editorRef.current;
    // 非内容区占用 = 根的可滚动内容高 - 内容元素高。
    // 用 scrollHeight 而不是 clientHeight：内容元素被压到 0（新增的行把空间吃满）时，
    // clientHeight 会随窗口一起变大、把 chrome 少算一截；scrollHeight 反映的是真实内容高，
    // 两种情形都对。不饱和时两者相等，行为不变。
    const chrome = root.scrollHeight - (contentEl?.clientHeight ?? 0);
    // 编辑区要保住一个舒服的下限，否则短句时只剩一行高；只读文本区按实际内容高。
    const contentNeed = contentEl
      ? Math.max(contentEl.scrollHeight, isEditor ? BAR_EDITOR_MIN_HEIGHT : 0)
      : 0;

    const target = Math.min(
      Math.max(chrome + contentNeed + BAR_MARGINS, BAR_MIN_HEIGHT),
      BAR_MAX_HEIGHT
    );
    const rounded = Math.round(target);
    if (rounded === lastHeightRef.current) return;
    lastHeightRef.current = rounded;
    vp.resizeBar(rounded);
  }, [
    draft, committed, snap, error, copied, hint, edited,
    polishOut, polishing, polishError, vp,
  ]);

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

  // 「当前有效文本」：有润色结果就以润色结果为准，否则用编辑区。
  // 复制 / 采纳都取这一份 —— 用户点了润色就是想让这段文本生效。
  const effectiveText = polishOut.length > 0 ? polishOut : edited;

  const copy = useCallback(async () => {
    await persistEdited();
    const ok = await vp.copy(effectiveText);
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
  }, [effectiveText, persistEdited, vp, t]);

  /** 「打开应用」：带着编辑后的文本去主应用（悬浮条随即关闭）。 */
  const openApp = useCallback(() => {
    void (async () => {
      // 先 await 一次，保证 historyId 已就绪再把它交给主应用；
      // 否则快速点击时带过去的是 undefined（见 resolveHistoryId）。
      await persistEdited();
      void vp.openStudio({ text: edited, historyId: historyIdRef.current ?? undefined });
    })();
    void vp.toggle();
  }, [edited, persistEdited, vp]);

  const close = useCallback(() => {
    void persistEdited();
    void vp.toggle();
  }, [persistEdited, vp]);

  /**
   * 采纳：把「当前有效文本」写进剪贴板，再让主进程把它粘回**快捷键触发那一刻的
   * 前台窗口**。
   *
   * 剪贴板从不还原（spec 2026-09-13 §0），所以失败时文本仍在剪贴板里 —— 失败的
   * 后果是「没省一步」而不是「文本丢了」，这也是失败分支敢直接给提示的原因。
   */
  const adopt = useCallback(async () => {
    await persistEdited();
    // 有润色结果时把它作为「采用后的正式文本」回写历史。
    // 回写失败不阻塞采纳：界面闭环优先。
    if (polishOut.length > 0) {
      try {
        await vp.adoptPolish({
          // 必须显式带上本条会话的历史 id，理由见 2A 的 Critical 修复（ee1ab8a）。
          id: historyIdRef.current ?? undefined,
          polished: polishOut,
          scene: scene?.name ?? '',
          tone: tone?.name ?? '',
        });
      } catch {
        /* 回写失败不阻塞采纳 */
      }
    }

    const ok = await vp.copy(effectiveText);
    if (!ok) {
      showError({ kind: 'clipboard', message: t('bar.err.clipboard') });
      return;
    }

    // 剪贴板已写好，现在置前 + 发粘贴键。主进程返回的 reason 决定提示文案。
    let r: Awaited<ReturnType<typeof vp.adoptPaste>>;
    try {
      r = await vp.adoptPaste();
    } catch (e) {
      // IPC 拒绝（主进程未就绪等）。当作一次普通失败，不能让异常冒成
      // unhandled rejection 把悬浮条卡在无提示的状态。
      r = { ok: false, reason: 'send-failed' };
      console.warn(`[采纳] 写回通道失败：${e instanceof Error ? e.message : String(e)}`);
    }
    if (r.ok) {
      // 写回成功：与「复制」同一收尾（reviewing 下 toggle 的语义就是关闭）。
      void vp.toggle();
      return;
    }
    setHint(ADOPT_FAIL_TEXT[r.reason] ?? t('bar.adopt.fail'));
  }, [effectiveText, polishOut, persistEdited, scene, tone, vp, t]);

  // 悬浮条内润色：把编辑区文本连同场景/语气发给主进程，流式结果落到下半区。
  // 场景/语气常驻在条底，理论上总有值；真拉不到预设时（DB/通道异常）给出明确
  // 提示而不是静默无反应。
  // setHint('')：一次性提示（「已复制，请手动粘贴」）在用户发起新动作时清掉。
  const runPolish = useCallback(() => {
    if (!scene || !tone) {
      setHint(t('bar.err.noPresets'));
      return;
    }
    setPolishOut('');
    setPolishError(null);
    setHint('');
    setPolishing(true);
    void vp
      .startPolish({ text: edited, scene, tone, target: 'bar' })
      .then((ok) => {
        // 主进程在目标窗口不存在/已销毁时返回 false（事件无处可发，等于这次润色
        // 根本没跑）。以前这条路径静默丢弃一切事件而 polishing 停在 true，按钮
        // 从此卡死禁用。这里转成一次失败，走与 catch 相同的收尾。
        if (!ok) throw new Error(t('bar.err.polishStart'));
      })
      .catch((e) => {
        // 下发失败（IPC 拒绝/主进程未就绪）必须收尾，否则 polishing 永远为真，
        // 「润色」按钮就此卡死禁用，还会冒成 unhandled rejection。
        setPolishing(false);
        setPolishError(e instanceof Error ? e.message : String(e));
      });
  }, [edited, scene, tone, vp, t]);

  // idle 时什么都不渲染。窗口是透明的，不渲染就等于隐藏。
  // 但出错时即便已回到 idle 也要多停留几秒（errorHold），
  // 否则错误提示一闪而过，用户只看到悬浮条闪了一下（A7）。
  if (snap.state === 'idle' && !errorHold) return null;

  return (
    <div
      ref={barRef}
      data-state={snap.state}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={styles.bar}
    >
      <div data-testid="bar-head" style={styles.head}>
        <span style={styles.badge}>{LABEL[snap.state]}</span>
        {snap.notice && (
          <span style={styles.notice}>
            {snap.notice.message}
            {snap.notice.attempt
              ? t('bar.retry', { attempt: snap.notice.attempt, max: snap.notice.maxAttempts })
              : ''}
          </span>
        )}
        {/* 「打开应用」只作用于成稿文本，且会把文本交给主应用 —— 聆听三态里
            点击只会和听写抢场控，所以仅 reviewing 显示。marginLeft:'auto' 把它
            推到头部右端（头部是 flex 行）。无障碍名只剩 aria-label/title
            （没有可见文字），两个都要给。 */}
        {snap.state === 'reviewing' && (
          <button
            style={styles.iconButton}
            data-testid="bar-open-app"
            title={t('bar.openApp')}
            aria-label={t('bar.openApp')}
            onClick={openApp}
          >
            {/* 内联 SVG（14×14，无图标库依赖）：圆角矩形 + 从右上角逃逸的箭头 */}
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="2" y="4" width="8" height="8" rx="1.5" />
              <path d="M8 2h4v4" />
              <path d="M12 2 6.5 7.5" />
            </svg>
          </button>
        )}
      </div>

      {error && <div style={styles.error}>{ERROR_TEXT[error.kind] ?? error.message}</div>}

      {/* reviewing 是可编辑面：textarea 是唯一真源；其余态保持只读展示（A2） */}
      {snap.state === 'reviewing' ? (
        <textarea
          ref={editorRef}
          data-testid="bar-editor"
          style={styles.editor}
          value={edited}
          onChange={(e) => {
            setEdited(e.target.value);
            // 用户一改文本，上一次润色失败的错误面板就过期了，不该继续挂着
            // （死掉的面板会占着布局、还让人以为这次也失败了）。
            setPolishError(null);
          }}
          placeholder={t('bar.editPlaceholder')}
        />
      ) : (
        <div ref={textRef as Ref<HTMLDivElement>} style={styles.text} data-testid="text">
          {paragraphs.map((lines, i) => (
            <span key={i}>
              {lines.join('')}
              {i < paragraphs.length - 1 ? '\n' : ''}
            </span>
          ))}
          {draft && <span style={styles.draft}>{draft}</span>}
        </div>
      )}

      {/* 下半只读区：流式润色结果。**只在真有内容时渲染** —— polishing 刚起、
          还没收到任何 delta 时（也无错误）渲染一个空盒子只会白占布局，把编辑区
          挤扁（Finding 3）。有错误时优先显示错误（即使已无结果）。
          在编辑区与按钮行之间，flex:'0 0 auto' 保证不会把编辑区压没。 */}
      {snap.state === 'reviewing' && (polishOut.length > 0 || polishError) && (
        <div data-testid="bar-polish-output" style={styles.output}>
          {polishError ? t('polish.errorPrefix') + polishError : polishOut}
        </div>
      )}

      {snap.state === 'reviewing' && (
        <>
          <div data-testid="bar-actions" style={styles.actions}>
            <button
              style={styles.button}
              data-testid="bar-polish"
              onClick={runPolish}
              disabled={edited.trim().length === 0 || polishing}
            >
              {polishing ? t('polish.running') : t('bar.polish')}
            </button>
            <button
              style={styles.button}
              data-testid="bar-copy"
              onClick={copy}
              // 按 effectiveText 判断，不能按 edited：只有润色结果、编辑区被清空时
              // edited.length===0 会把一个本来可复制的非空文本锁死禁用。
              disabled={effectiveText.length === 0}
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
            <button style={styles.ghost} onClick={() => void close()}>
              {t('bar.close')}
            </button>
            {snap.truncated && <span style={styles.warn}>{t('bar.truncated')}</span>}
          </div>
          {/* 场景/语气常驻条底：不再折叠。折叠态在小窗里会被裁掉、点了像没反应，
              而这两个值决定润色请求，应该一眼可见。仅可选预设，不能在此增改。 */}
          <div style={styles.advanced}>
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
          </div>
        </>
      )}

      {copied && (
        <div data-testid="bar-hint-copied" style={styles.hint}>
          {t('bar.copied')}
        </div>
      )}
      {hint && (
        <div data-testid="bar-hint-adopt" style={styles.hint}>
          {hint}
        </div>
      )}
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
  // 润色结果下半区：与 editor 同款边框/内边距，但底色略深以示「不是可编辑的原文」。
  // flex:'0 0 auto' —— 编辑区仍是 flex:1 的主角，结果区不参与抢空间，
  // 长结果靠自己的 overflowY 滚动。
  output: {
    flex: '0 0 auto' as const,
    maxHeight: 120,
    overflowY: 'auto' as const,
    border: '1px solid #d1d5db',
    borderRadius: 6,
    padding: 8,
    background: '#f1f5f9',
    scrollbarWidth: 'thin' as const,
    whiteSpace: 'pre-wrap' as const,
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
  // 头部右侧的小图标按钮（「打开应用」）。marginLeft:'auto' 在 flex 头部行里
  // 把它推到最右。lineHeight:0 消掉行内基线带来的多余高度。
  iconButton: {
    marginLeft: 'auto',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 4,
    borderRadius: 6,
    border: '1px solid #d1d5db',
    background: 'transparent',
    color: '#6b7280',
    cursor: 'pointer' as const,
    lineHeight: 0,
  },
  hint: { color: '#6b7280', fontSize: 11, flexShrink: 0 },
} satisfies Record<string, CSSProperties>;
