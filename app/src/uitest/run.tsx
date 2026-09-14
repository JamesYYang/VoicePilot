import { createRoot } from 'react-dom/client';
import App from '../App';
import Studio from '../studio/Studio';
import SettingsView from '../studio/SettingsView';
import { I18nProvider } from '../i18n';
import { acceleratorFromEvent } from '../studio/shortcutKeys';
import { derivePhraseTitle } from '../phrases/title';

/**
 * 悬浮条界面自测。用法：
 *   cd app && VP_UI_SELFTEST=1 npx electron .
 *
 * 存在的理由：A1/A2 里只有「不抢焦点」必须人来验（要看目标应用的光标与输入法
 * 状态），其余部分——状态渲染、草稿/定稿切换、分段、复制、背压丢帧——都能在
 * 没有麦克风的机器上自动跑完。人在机器前的时间应该花在刀刃上。
 *
 * 做法是给 App 注入假 bridge 与假采集源，但**复制走真实 IPC**：
 * 主进程的 vp:copy 会读回剪贴板核对再返回布尔值，所以返回值本身
 * 就是「剪贴板真的写进去了」的断言，不需要额外的读取通道。
 */

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, cond: unknown, detail = '') {
  results.push({ name, ok: Boolean(cond), detail });
  console.log(`${cond ? ' ok ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const flush = () => sleep(30);

/**
 * 轮询等待条件成立。
 *
 * 复制要跨进程走一趟 IPC，而主进程那边要等剪贴板写入返回 —— 剪贴板不可用时
 * 这个等待能到几秒（Windows 会一直重试到超时）。所以**不能**用固定 30ms
 * 的 flush 去等，否则断言跑在实际结果之前，看起来像「功能坏了」。
 */
const waitFor = async (cond: () => boolean, timeout = 8000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(25);
  }
  return false;
};

const IDLE = { state: 'idle', notice: null, truncated: false, origin: 'dictation' } as const;

export async function runUiTest() {
  console.log('=== 悬浮条界面自测 ===');

  const real = window.voicepilot;

  // 监听器按真实签名声明，fire() 就能在调用点校验载荷形状，
  // 不会出现「测试自己传错了字段却没报错」的情况
  const listeners: {
    state?: (s: SessionSnapshot) => void;
    partial?: (p: AsrPartial) => void;
    error?: (e: { kind: string; message: string; preserveText: boolean }) => void;
    ack?: (a: { seq: number; pending: number }) => void;
  } = {};
  type Channel = keyof typeof listeners;

  const sentFrames: { seq: number; cumSamples: number }[] = [];
  let toggleCount = 0;
  // 用对象 holder 而不是 `let x: string|null`：TS 会把它在流里收窄成 null/never
  const openStudioCtl: { arg: string | null } = { arg: null };
  const historySaveCtl: { payload: { text: string } | null } = { payload: null };
  // 记录 historyUpdateText 的载荷：这是「编辑后回写同一条历史」的唯一证据，
  // 之前 stub 成 () => Promise.resolve(true) 把参数丢了，写错 id/文本都测不出来。
  const historyUpdateCtl: { payload: { id: number; text: string } | null } = { payload: null };
  // 记录真实传给 vp.copy 的那串文本。悬浮条界面上看不出「复制的内容对不对」——
  // 之前这里只查展示文本里有没有某个子串，所以 fullText 的换行错位一直没被抓到。
  const copyCtl: { text: string | null } = { text: null };
  // 最近一次真桥 copy 的 Promise。本机剪贴板不可用时 real.copy 可能耗时数秒，
  // 若不等它收尾，它的 setCopied(ok) 会晚于下一段「采纳」的 setCopied(true) 落地，
  // 把 copied 又打回 false，掩盖 Finding 1 的重复提示回归。见第 22 段末尾的 await。
  let lastCopy: Promise<boolean> = Promise.resolve(false);
  // 悬浮条（App）自己的润色流式监听器 holder。App 与 Studio 是两个独立的假
  // bridge（见下方 studioBridge），各存各的，不会互相覆盖。Task 5 之前 App 没
  // 订阅过这三个事件，缺了它们点「润色」后 delta 无处可发，测试永远红。
  const barPolishDelta: { cb: ((p: { text: string }) => void) | null } = { cb: null };
  const barPolishDone: { cb: (() => void) | null } = { cb: null };
  const barPolishError: { cb: ((p: { message: string }) => void) | null } = { cb: null };
  // 采纳写回的返回值由每条用例自己摆：默认「成功」，Task 7 的失败分支按 reason 改。
  // 它必须**显式**挂在假 bridge 上 —— `...real` 复制不到 contextBridge 的非枚举属性
  // （见本文件 copy 那段的注释）。缺了它 App 调 vp.adoptPaste() 会抛 TypeError，
  // async 函数静默 reject，表现是「点了采纳毫无反应」。
  // 类型直接取自桥的返回类型（而不是字面写 reason: string）—— 后者给不出接口要求的
  // reason 字面量联合，假 bridge 赋给 bridge prop 时 typecheck 会红。
  const adoptPasteCtl: {
    result: Awaited<ReturnType<Window['voicepilot']['adoptPaste']>>;
    calls: number;
  } = {
    result: { ok: true },
    calls: 0,
  };
  const phraseSaveCtl: { payload: { title: string; text: string } | null } = { payload: null };
  /** 每次 setMousePassthrough 的实参。穿透开关只有一处调用点（鼠标移入/移出），见 26c。 */
  const passthroughCalls: boolean[] = [];
  let togglePhrasesCalls = 0;
  let usePhraseCalls = 0;
  const touchedIds: number[] = [];
  // 选择器列表由每条用例自己摆（顺序即主进程给的「最近使用优先」）。
  let phraseRows: PhraseRow[] = [];
  let captureStarted = false;
  let captureStopped = false;
  // 初值给空函数而不是 null：这样类型是「永远可调用」，
  // 不用在每处调用点跟 TS 的控制流收窄较劲（收窄会把它判成 never）
  let pushBatch: (pcm: Int16Array) => void = () => {};
  let ackedSeq = 0;

  const bridge = {
    ...real,
    onState: (cb: NonNullable<(typeof listeners)['state']>) => {
      listeners.state = cb;
      return () => {};
    },
    onPartial: (cb: NonNullable<(typeof listeners)['partial']>) => {
      listeners.partial = cb;
      return () => {};
    },
    onError: (cb: NonNullable<(typeof listeners)['error']>) => {
      listeners.error = cb;
      return () => {};
    },
    onAck: (cb: NonNullable<(typeof listeners)['ack']>) => {
      listeners.ack = cb;
      return () => {};
    },
    // ⚠️ 这两个必须显式委托，不能指望 `{...real}` 把它们带过来 ——
    // contextBridge 暴露的属性不是可枚举的，展开运算符复制不到，
    // 拿到的是 undefined，调用时抛 TypeError，async 函数静默 reject，
    // 表现是「点了复制毫无反应」，且控制台没有一行相关报错。
    copy: (text: string) => {
      copyCtl.text = text;
      lastCopy = real.copy(text);
      return lastCopy;
    },
    adoptPaste: () => {
      adoptPasteCtl.calls += 1;
      return Promise.resolve(adoptPasteCtl.result);
    },
    reportPainted: (at: number) => real.reportPainted(at),
    openStudio: (payload: { text: string; historyId?: number }) => {
      openStudioCtl.arg = payload.text;
      return Promise.resolve(true);
    },
    historySave: (payload: { text: string }) => {
      historySaveCtl.payload = payload;
      return Promise.resolve({ id: 1 });
    },
    // 悬浮条新链路（Task 3/4）用到的两个方法也必须显式委托 —— 同上，
    // `...real` 复制不到非枚举属性；缺了 polishPresets 会让 App 的预设
    // effect 直接抛 TypeError（未包 try），整轮自测崩在中间。
    polishPresets: () =>
      Promise.resolve({
        scenes: [{ id: 1, name: '邮件', description: '', lang: null, is_builtin: 1 }],
        tones: [{ id: 5, name: '正式', description: '', lang: null, is_builtin: 1 }],
        defaultSceneId: 1,
      }),
    historyUpdateText: (payload: { id: number; text: string }) => {
      historyUpdateCtl.payload = payload;
      return Promise.resolve(true);
    },
    // 悬浮条内润色（Task 5）。与 Studio 的假 bridge 分开声明是必须的：
    // App 收的是这个 bridge，Studio 收的是 studioBridge，两者监听器各挂各的。
    // 载荷里 target 是 Task 3 新增的路由字段，直接记进 polishCall/adoptCall，
    // 与 Studio 断言共用同一批 holder（Studio 的断言在本文件更早处已跑完）。
    startPolish: (payload: { text: string; scene: Preset; tone: Preset; target?: 'bar' | 'studio' }) => {
      polishCall.payload = payload;
      return Promise.resolve(true);
    },
    adoptPolish: (payload: { id?: number; polished: string; scene: string; tone: string }) => {
      adoptCall.payload = payload;
      return Promise.resolve(true);
    },
    togglePhrases: () => {
      togglePhrasesCalls += 1;
      return Promise.resolve(IDLE);
    },
    usePhrase: () => {
      usePhraseCalls += 1;
      return Promise.resolve(IDLE);
    },
    phrasesList: () => Promise.resolve(phraseRows),
    phrasesTouch: (id: number) => {
      touchedIds.push(id);
      return Promise.resolve(true);
    },
    phrasesSave: (payload: { title: string; text: string }) => {
      phraseSaveCtl.payload = payload;
      return Promise.resolve({ id: 99 });
    },
    onPolishDelta: (cb: (p: { text: string }) => void) => {
      barPolishDelta.cb = cb;
      return () => {};
    },
    onPolishDone: (cb: () => void) => {
      barPolishDone.cb = cb;
      return () => {};
    },
    onPolishError: (cb: (p: { message: string }) => void) => {
      barPolishError.cb = cb;
      return () => {};
    },
    toggle: () => {
      toggleCount += 1;
      return Promise.resolve(IDLE);
    },
    syncState: () => Promise.resolve(IDLE),
    sendAudio: (meta: { seq: number; cumSamples: number }) => {
      sentFrames.push(meta);
    },
    setMousePassthrough: (passthrough: boolean) => {
      passthroughCalls.push(passthrough);
    },
    resizeBar: () => {},
    captureFailed: () => {},
  };

  // 设成 true 可让采集启动失败，用来验 A7 的「麦克风被占用」路径
  let failCapture = false;

  const createCapture = (onBatch: (pcm: Int16Array) => void) => {
    pushBatch = onBatch;
    return {
      start: async () => {
        if (failCapture) throw new DOMException('Requested device not found', 'NotFoundError');
        captureStarted = true;
      },
      stop: async () => {
        captureStopped = true;
      },
    };
  };

  const fire = <K extends Channel>(
    channel: K,
    payload: Parameters<NonNullable<(typeof listeners)[K]>>[0]
  ) => {
    (listeners[channel] as ((p: typeof payload) => void) | undefined)?.(payload);
  };

  const container = document.getElementById('root');
  if (!container) throw new Error('找不到 #root');
  createRoot(container).render(<App bridge={bridge} createCapture={createCapture} />);
  await flush();

  // ---- 1. idle 不渲染 ----
  check('idle 时不渲染任何东西', container.textContent === '', JSON.stringify(container.textContent));

  // ---- 2. warming：出现并开始采集 ----
  fire('state', { state: 'warming', notice: null, truncated: false, origin: 'dictation' });
  await flush();
  check('warming 渲染出「准备中」', container.textContent?.includes('准备中'));
  // 用真值判断而非 ===true：TS 会把 `let x = false` 在流里收窄成字面量 false，
  // 与 true 比较会被判为「无重叠」
  check('warming 时启动采集', captureStarted);

  // ---- 3. 音频上行 ----
  pushBatch(new Int16Array(1600));
  await flush();
  check('收到一批就上行一帧', sentFrames.length === 1, `发了 ${sentFrames.length} 帧`);
  check('帧 meta 正确', sentFrames[0]?.seq === 1 && sentFrames[0]?.cumSamples === 1600,
    JSON.stringify(sentFrames[0]));

  // ---- 4. listening + 草稿 ----
  fire('state', { state: 'listening', notice: null, truncated: false, origin: 'dictation' });
  fire('partial', {
    recvAtMs: Date.now(),
    text: '今天我们要讨论',
    sentenceEnd: false,
    sentenceId: 's0',
    beginTime: 0,
    endTime: 520,
    words: [],
  });
  await flush();
  const textEl = container.querySelector('[data-testid="text"]');
  check('草稿上屏', textEl?.textContent?.includes('今天我们要讨论') === true,
    JSON.stringify(textEl?.textContent));
  check('草稿是灰字（有 draft 节点）', container.querySelector('span[style*="156"]') !== null ||
    textEl?.innerHTML.includes('9ca3af') === true);

  // ---- 5. 定稿 + 每句一行 ----
  // 新规则：每个定稿句单独一行，不再看句间停顿长短（原「按停顿分自然段」
  // 判据已证伪：阈值是中位数 × 2.5，正常说话永远不会触发）。这里刻意连说
  // 几句、句间都是 300ms 短停顿，仍然必须逐句换行。
  fire('partial', {
    recvAtMs: Date.now(),
    text: '今天我们要讨论三件事',
    sentenceEnd: true,
    sentenceId: 's1',
    beginTime: 0,
    endTime: 900,
    words: [],
  });
  fire('partial', {
    recvAtMs: Date.now(),
    text: '第一件是采集',
    sentenceEnd: true,
    sentenceId: 's2',
    beginTime: 1200, // 与上句末尾隔 300ms
    endTime: 2100,
    words: [],
  });
  fire('partial', {
    recvAtMs: Date.now(),
    text: '第二件是识别',
    sentenceEnd: true,
    sentenceId: 's3',
    beginTime: 2400, // 隔 300ms
    endTime: 3300,
    words: [],
  });
  await flush();
  const committedEl = container.querySelector('[data-testid="text"]');
  check('定稿后多句都在', committedEl?.textContent?.includes('三件事') === true &&
    committedEl?.textContent?.includes('第一件是采集') === true &&
    committedEl?.textContent?.includes('第二件是识别') === true,
    JSON.stringify(committedEl?.textContent));
  // 每个定稿句单独一行，与停顿长短无关
  check('每个定稿句单独一行',
    committedEl?.textContent?.includes('今天我们要讨论三件事\n第一件是采集\n第二件是识别') === true,
    JSON.stringify(committedEl?.textContent));

  // 再定稿一句，同样另起一行 —— 换行位置在第三件之前
  fire('partial', {
    recvAtMs: Date.now(),
    text: '第三件是润色',
    sentenceEnd: true,
    sentenceId: 's4',
    beginTime: 5300,
    endTime: 6200,
    words: [],
  });
  await flush();
  check('下一句定稿后另起一行，换行在第三件之前',
    committedEl?.textContent?.includes('第二件是识别\n第三件是润色') === true,
    JSON.stringify(committedEl?.textContent));

  // ---- 6. reviewing + 复制（走真实 IPC，主进程读回剪贴板核对）----
  fire('state', { state: 'reviewing', notice: null, truncated: false, origin: 'dictation' });
  await flush();
  const buttons = Array.from(container.querySelectorAll('button'));
  check('reviewing 出现「复制」按钮', buttons.some((b) => b.textContent === '复制'));

  const copyBtn = buttons.find((b) => b.textContent === '复制');
  // 四个定稿句「每句一行」后的全文，就是复制 / 落库 / 送润色都该拿到的那一份文本。
  // 断言用全等而不是 includes：换行错位（首两句粘连、尾部多一个换行）必须能红。
  const expectedCommittedText =
    '今天我们要讨论三件事\n第一件是采集\n第二件是识别\n第三件是润色';

  // 先探测剪贴板在这个环境里到底能不能用。
  // 有些会话环境（沙箱、远程桌面）根本拿不到剪贴板 —— 那就不能拿
  // 「复制成功」当断言，否则会一直红，而真正该抓的回归反而被淹掉。
  const clipUsable = await real.copy('__clipboard_probe__');
  if (!clipUsable) {
    console.log('[提示] 本机剪贴板不可用（沙箱/远程会话常见），成功路径改为抽查失败提示');
  }

  // 每次点击前重新查询按钮：React 重渲染会换掉 DOM 节点，
  // 抓早了的引用点到的是已从文档里摘掉的旧节点，事件传不到 React 的根容器，
  // 表现是「点了没反应」——这种假失败极难查。
  const clickButton = (label: string) => {
    const btn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === label
    );
    if (!btn) throw new Error(`找不到按钮「${label}」`);
    btn.click();
  };
  // 「打开应用」现在是无文字的头部图标，按文本点不到，只能按 testid 找。
  // 每次点击前重新查询，理由同 clickButton（React 重渲染会换 DOM 节点）。
  const clickTestId = (id: string) => {
    const btn = container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
    if (!btn) throw new Error(`找不到 [data-testid="${id}"]`);
    btn.click();
  };

  clickButton('复制');

  if (clipUsable) {
    const ok = await waitFor(() => container.textContent?.includes('已复制到剪贴板') === true);
    check('复制后主进程确认写入成功（已读回剪贴板核对）', ok, JSON.stringify(container.textContent));
    check('复制后触发关闭', toggleCount === 1, `toggle 调用 ${toggleCount} 次`);
  } else {
    // 环境不支持时，能验的是「失败必须看得见」——静默失败才是真正的坑
    const shown = await waitFor(() => container.textContent?.includes('复制失败') === true);
    check('复制失败时给出明确提示（不静默）', shown, JSON.stringify(container.textContent));
    check('复制失败时不关闭悬浮条（留给用户重试）', toggleCount === 0,
      `toggle 调用 ${toggleCount} 次`);
  }
  check('复制内容与界面文本一致', copyCtl.text === expectedCommittedText,
    JSON.stringify(copyCtl.text));

  // ---- 6.5 润色 + 历史保存：进入 reviewing 时原文已写入历史一次 ----
  fire('state', { state: 'reviewing', notice: null, truncated: false, origin: 'dictation' });
  await flush();
  check('reviewing 时已调用 historySave 且带全文',
    historySaveCtl.payload?.text === expectedCommittedText,
    JSON.stringify(historySaveCtl.payload));
  toggleCount = 0;
  openStudioCtl.arg = null;
  // Task 4 起「润色」改为条内润色入口（Task 5 落地），打开主应用改由头部的
  // 「打开应用」图标承担（无文字，只能按 testid 点）。
  clickTestId('bar-open-app');
  await flush();
  // 显式断言绕开 TS 对对象属性的流收窄（否则被收窄成 never）
  const openedArg = openStudioCtl.arg as string | null;
  check('点「打开应用」调用 openStudio 且带全文', openedArg === expectedCommittedText,
    JSON.stringify(openedArg));
  check('点「打开应用」后悬浮条关闭（触发 toggle）', toggleCount === 1, `toggle 调用 ${toggleCount} 次`);

  // ---- 7. 背压：未确认帧数超上限就丢 ----
  fire('state', { state: 'listening', notice: null, truncated: false, origin: 'dictation' });
  await flush();
  // 先把之前那 1 帧的回执补上，让未确认计数归零，否则上限要减掉它
  fire('ack', { seq: 1, pending: 0 });
  await flush();
  sentFrames.length = 0;
  // 主进程一个 ack 都不回，连推 12 批
  for (let i = 0; i < 12; i++) pushBatch(new Int16Array(1600));
  await flush();
  check('未确认帧数达上限后停止上行', sentFrames.length === 8, `发了 ${sentFrames.length} 帧（上限 8）`);

  // 回执后恢复上行
  ackedSeq = sentFrames[sentFrames.length - 1].seq;
  fire('ack', { seq: ackedSeq, pending: 0 });
  await flush();
  pushBatch(new Int16Array(1600));
  await flush();
  check('收到回执后恢复上行', sentFrames.length === 9, `发了 ${sentFrames.length} 帧`);

  // ---- 8. 采集失败（A7：麦克风被占用时必须看得见）----
  // 回到 idle 再重新触发，让采集源以失败的方式启动一次
  fire('state', { state: 'idle', notice: null, truncated: false, origin: 'dictation' });
  await flush();
  failCapture = true;
  let captureFailReported = false;
  bridge.captureFailed = () => {
    captureFailReported = true;
  };
  fire('state', { state: 'warming', notice: null, truncated: false, origin: 'dictation' });
  await waitFor(() => captureFailReported);
  check('采集失败上报主进程', captureFailReported);
  check('采集失败在界面上有明确提示',
    container.textContent?.includes('麦克风不可用') === true,
    JSON.stringify(container.textContent));

  // 状态机随后会回到 idle，但错误要再多停几秒（App.tsx 的 ERROR_HOLD_MS），
  // 否则用户只看到悬浮条闪了一下，等于没提示
  fire('state', { state: 'idle', notice: null, truncated: false, origin: 'dictation' });
  await flush();
  check('回到 idle 后错误仍停留可见',
    container.textContent?.includes('麦克风不可用') === true,
    JSON.stringify(container.textContent));
  await sleep(5600); // ERROR_HOLD_MS = 5000 + 缓冲
  check('停留窗口结束后自动隐藏', container.textContent === '',
    JSON.stringify(container.textContent));

  // ---- 9. Studio（润色工作区）----
  // 换一个干净的容器：Studio 与悬浮条 App 是两棵独立的树，不能共用一个 root。
  const studioContainer = document.createElement('div');
  document.body.appendChild(studioContainer);

  // 用对象属性兜住调用载荷：TS 会把 `let x = null` 收窄成 null（闭包里的
  // 赋值不在它的流分析里），属性访问则不会被这样收窄。
  const polishCall: { payload: { text: string; scene: Preset; tone: Preset; target?: 'bar' | 'studio' } | null } = { payload: null };
  const adoptCall: { payload: { id?: number; polished: string; scene: string; tone: string } | null } = { payload: null };
  // 给 Studio 注入假 bridge（与 App 同款模式），不动只读的 window.voicepilot。
  // onStudioRefresh 必须多播：Studio 与 PolishView 都会订阅（真实 preload 的
  // ipcRenderer.on 是多播），单播 mock 会互相覆盖。
  const studioRefreshCbs: ((p: { text: string }) => void)[] = [];
  // 润色流式事件监听器，供测试按真实签名 fire 载荷（与 studioRefresh 同款模式）
  const studioDelta: { cb: ((p: { text: string }) => void) | null } = { cb: null };
  const studioDone: { cb: (() => void) | null } = { cb: null };
  const studioError: { cb: ((p: { message: string }) => void) | null } = { cb: null };
  const phraseCtl = {
    rows: [
      { id: 1, title: '问候', text: '您好，收到您的反馈。', created_at: 2, updated_at: 2, used_at: null },
    ] as PhraseRow[],
    saved: null as { title: string; text: string } | null,
    deleted: [] as number[],
  };
  const studioBridge = {
    ...real,
    onStudioRefresh: (cb: (p: { text: string }) => void) => { studioRefreshCbs.push(cb); return () => {}; },
    syncStudio: () =>
      Promise.resolve({
        text: '测试原文',
        scenes: [{ id: 1, name: '邮件', description: '', lang: null, is_builtin: 1 }],
        tones: [{ id: 5, name: '正式', description: '', lang: null, is_builtin: 1 }],
        defaultSceneId: null,
      }),
    startPolish: (p: { text: string; scene: Preset; tone: Preset }) => {
      polishCall.payload = p;
      return Promise.resolve(true);
    },
    adoptPolish: (p: { id?: number; polished: string; scene: string; tone: string }) => {
      adoptCall.payload = p;
      return Promise.resolve(true);
    },
    onPolishDelta: (cb: (p: { text: string }) => void) => { studioDelta.cb = cb; return () => {}; },
    onPolishDone: (cb: () => void) => { studioDone.cb = cb; return () => {}; },
    onPolishError: (cb: (p: { message: string }) => void) => { studioError.cb = cb; return () => {}; },
    listPresets: () => Promise.resolve([{ id: 1, name: '邮件', description: '', lang: null, is_builtin: 1 }]),
    savePreset: () => Promise.resolve({ id: 2 }),
    deletePreset: () => Promise.resolve(true),
    phrasesList: () => Promise.resolve(phraseCtl.rows),
    phrasesSave: (p: { title: string; text: string }) => {
      phraseCtl.saved = p;
      phraseCtl.rows = [
        ...phraseCtl.rows,
        { id: 2, title: p.title, text: p.text, created_at: 3, updated_at: 3, used_at: null },
      ];
      return Promise.resolve({ id: 2 });
    },
    phrasesUpdate: () => Promise.resolve(true),
    phrasesDelete: (id: number) => {
      phraseCtl.deleted.push(id);
      phraseCtl.rows = phraseCtl.rows.filter((r) => r.id !== id);
      return Promise.resolve(true);
    },
    // i18n：en-US 断言要经 I18nProvider 走 getLanguage/onLanguageChanged。
    // 这两个必须显式声明 —— 与上面 copy/reportPainted 同理，`...real`
    // 复制不到 contextBridge 的非枚举属性，缺了会静默 reject。
    getLanguage: () => Promise.resolve({ locale: 'en-US' as const }),
    onLanguageChanged: () => () => {},
  };

  createRoot(studioContainer).render(<Studio bridge={studioBridge} />);
  await waitFor(() => studioContainer.querySelector('textarea')?.value === '测试原文');
  check(
    'Studio 编辑器初值为 syncStudio 下发的文本',
    studioContainer.querySelector('textarea')?.value === '测试原文',
    JSON.stringify(studioContainer.querySelector('textarea')?.value)
  );
  check(
    'Studio 有场景下拉',
    studioContainer.querySelector('[data-testid="polish-scene"]') !== null
  );
  check(
    'Studio 有语气下拉',
    studioContainer.querySelector('[data-testid="polish-tone"]') !== null
  );

  // 点「润色」→ 应调 startPolish（本任务 stub，只验调用与载荷）
  studioContainer.querySelector<HTMLButtonElement>('[data-testid="polish-run"]')?.click();
  await flush();
  check(
    '点润色调用了 startPolish 且载荷正确',
    polishCall.payload?.text === '测试原文' &&
      polishCall.payload?.scene?.name === '邮件' &&
      polishCall.payload?.tone?.name === '正式',
    JSON.stringify(polishCall.payload)
  );

  // ---- 10. Studio 已存在时刷新文本（重复口述→再点润色）----
  // 主进程在窗口已存在时只 focus 不重载，改为推 vp:studio/refresh 事件，
  // 编辑器必须据此更新，否则用户第二次口述后看到的仍是第一次的文本。
  for (const cb of studioRefreshCbs) cb({ text: '第二次口述的新文本' });
  await flush();
  check(
    'Studio 编辑器随 studioRefresh 刷新为新文本',
    studioContainer.querySelector('textarea')?.value === '第二次口述的新文本',
    JSON.stringify(studioContainer.querySelector('textarea')?.value)
  );

  // ---- 11. 流式增量：主进程逐块推 delta → 输出区逐字追加（Task 5）----
  check(
    '润色中「润色」按钮禁用',
    studioContainer.querySelector<HTMLButtonElement>('[data-testid="polish-run"]')?.disabled ===
      true
  );
  studioDelta.cb?.({ text: '润色后的' });
  studioDelta.cb?.({ text: '第一句' });
  await flush();
  const outputEl = studioContainer.querySelector('[data-testid="polish-output"]');
  check(
    '润色 delta 逐字追加到输出区',
    outputEl?.textContent === '润色后的第一句',
    JSON.stringify(outputEl?.textContent)
  );
  studioDone.cb?.();
  await flush();
  check(
    '润色完成后按钮恢复可点',
    studioContainer.querySelector<HTMLButtonElement>('[data-testid="polish-run"]')?.disabled ===
      false
  );

  // ---- 11.5 采用：润色结果替换编辑区原文，并清空结果区（Task 6）----
  studioContainer.querySelector<HTMLButtonElement>('[data-testid="polish-adopt"]')?.click();
  await flush();
  check(
    '点「采用」把润色结果搬进编辑区原文',
    studioContainer.querySelector('textarea')?.value === '润色后的第一句',
    JSON.stringify(studioContainer.querySelector('textarea')?.value)
  );
  check(
    '点「采用」后清空润色结果区',
    studioContainer.querySelector('[data-testid="polish-output"]')?.textContent === '',
    JSON.stringify(studioContainer.querySelector('[data-testid="polish-output"]')?.textContent)
  );
  check('采用后调用了 adoptPolish 回写',
    adoptCall.payload?.polished === '润色后的第一句' &&
      adoptCall.payload?.scene === '邮件' &&
      adoptCall.payload?.tone === '正式',
    JSON.stringify(adoptCall.payload));

  // ---- 12. 润色失败：error 事件 → 显示错误 + 按钮恢复（Task 5 修复，单路径 emit）----
  studioContainer.querySelector<HTMLButtonElement>('[data-testid="polish-run"]')?.click();
  await flush();
  check(
    '润色失败路径：发起后按钮禁用',
    studioContainer.querySelector<HTMLButtonElement>('[data-testid="polish-run"]')?.disabled ===
      true
  );
  studioError.cb?.({ message: '测试错误' });
  await flush();
  check(
    '润色失败在输出区/错误区显示错误信息',
    studioContainer.textContent?.includes('润色失败：测试错误') === true,
    JSON.stringify(studioContainer.textContent)
  );
  check(
    '润色失败后按钮恢复可点',
    studioContainer.querySelector<HTMLButtonElement>('[data-testid="polish-run"]')?.disabled ===
      false
  );

  // ---- 13. i18n 三语断言：en-US 下 Studio 导航栏应为英文 ----
  // 单独起一个渲染实例套 I18nProvider，不动上面 zh-CN 默认语境下的断言流。
  // getLanguage 异步返回 en-US，需等 locale 翻转后再断言；否则会拿
  // I18nProvider 初始态（resolveLocale(navigator.language) 的映射值）误判。
  const enStudioContainer = document.createElement('div');
  document.body.appendChild(enStudioContainer);
  createRoot(enStudioContainer).render(
    <I18nProvider bridge={studioBridge}>
      <Studio bridge={studioBridge} />
    </I18nProvider>
  );
  const enNavLabels = () =>
    Array.from(enStudioContainer.querySelectorAll('aside button')).map((b) => b.textContent);
  const okEnNav = await waitFor(() => {
    const labels = enNavLabels();
    return labels.includes('Polish') && labels.includes('History') && labels.includes('Settings');
  });
  check(
    'en-US 下 Studio 导航栏为英文（Polish/History/Settings）',
    okEnNav,
    JSON.stringify(enNavLabels())
  );

  // ---- 21. 设置页快捷键 ----
  const settingsContainer = document.createElement('div');
  document.body.appendChild(settingsContainer);

  const shortcutSet: { payloads: string[] } = { payloads: [] };
  const suspendCalls: boolean[] = [];
  const settingsBridge = {
    ...real,
    // contextBridge 属性不可枚举，展开复制不到，用到的必须显式声明
    getLanguage: () => Promise.resolve({ locale: 'zh-CN' as const }),
    onLanguageChanged: () => () => {},
    setLanguage: () => Promise.resolve({ ok: true, locale: 'zh-CN' as const }),
    getPermissionStatus: () => Promise.resolve({ accessibility: null }),
    openAccessibilitySettings: () => Promise.resolve(false),
    getShortcut: () => Promise.resolve({ accel: 'Ctrl+Shift+Space', isDefault: true }),
    setShortcut: (a: string) => {
      shortcutSet.payloads.push(a);
      return Promise.resolve({ ok: true, accel: a });
    },
    suspendShortcut: (s: boolean) => {
      suspendCalls.push(s);
      return Promise.resolve(true);
    },
    getPhraseShortcut: () => Promise.resolve({ accel: 'Ctrl+Alt+Space', isDefault: true }),
    setPhraseShortcut: (a: string) => Promise.resolve({ ok: true, accel: a }),
  };

  createRoot(settingsContainer).render(<SettingsView bridge={settingsBridge} />);
  const accelEl = () => settingsContainer.querySelector('[data-testid="settings-shortcut"]')?.textContent;
  const shownInitial = await waitFor(() => accelEl() === 'Ctrl+Shift+Space');
  check('设置页渲染当前快捷键', shownInitial, JSON.stringify(accelEl()));

  const recBtn = settingsContainer.querySelector<HTMLButtonElement>('[data-testid="settings-shortcut-record"]');
  check('录制按钮存在', recBtn != null);

  recBtn?.click();
  await flush();
  // 进入录制后必须挂起全局快捷键，否则按下的组合键会被主进程当成一次听写
  check('进入录制时挂起全局快捷键', suspendCalls[0] === true, JSON.stringify(suspendCalls));

  // 录制态：派发一个带修饰键的 keydown（捕获阶段监听，派发到 window 即可命中）
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, altKey: true }));
  await flush();
  check('录制后调用 setShortcut 且载荷正确', shortcutSet.payloads[0] === 'Ctrl+Alt+Y',
    JSON.stringify(shortcutSet.payloads));
  check('录制结束（提交）时恢复全局快捷键',
    suspendCalls[suspendCalls.length - 1] === false, JSON.stringify(suspendCalls));
  const shownUpdated = await waitFor(() => accelEl() === 'Ctrl+Alt+Y');
  check('成功后界面显示新快捷键', shownUpdated, JSON.stringify(accelEl()));

  // ---- 21.5 纯修饰键忽略 + 冲突路径（Task 7 硬性约束，brief 断言未覆盖，此处补齐）----
  shortcutSet.payloads.length = 0;
  // 直接改写 bridge 上的方法：组件在事件触发时读 vp.setShortcut，
  // 所以换个实现即可模拟主进程注册失败，不需要重挂组件。
  settingsBridge.setShortcut = (a: string) => {
    shortcutSet.payloads.push(a);
    // 返回**候选值**而非当前显示值：这样「组件错误地把失败响应的 accel 应用上去」
    // 会让下面的「不更新当前显示」断言失败，断言才有鉴别力。
    return Promise.resolve({ ok: false, accel: 'Ctrl+Alt+K' });
  };

  settingsContainer.querySelector<HTMLButtonElement>('[data-testid="settings-shortcut-record"]')?.click();
  await flush();
  // 纯修饰键必须被忽略：既不提交，也不能退出录制态
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }));
  await flush();
  check('纯修饰键被忽略（不提交且仍在录制）',
    shortcutSet.payloads.length === 0 && accelEl() === '请按下新的组合键…',
    JSON.stringify({ payloads: shortcutSet.payloads, accel: accelEl() }));

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, altKey: true }));
  await flush();
  check('冲突候选已提交给 setShortcut', shortcutSet.payloads[0] === 'Ctrl+Alt+K',
    JSON.stringify(shortcutSet.payloads));
  const conflictShown = await waitFor(() =>
    settingsContainer.textContent?.includes('该快捷键已被占用，请换一个') === true);
  check('冲突时显示占用提示', conflictShown, JSON.stringify(settingsContainer.textContent));
  check('冲突时不更新当前显示的快捷键', accelEl() === 'Ctrl+Alt+Y', JSON.stringify(accelEl()));

  // Esc = 取消录制：裸 Esc 无修饰键，若不特判只会走「无法表达的键」分支，
  // 一直留在录制态（全局快捷键也一直被挂起）。这里必须能真的退出录制并恢复。
  shortcutSet.payloads.length = 0;
  settingsContainer.querySelector<HTMLButtonElement>('[data-testid="settings-shortcut-record"]')?.click();
  await flush();
  const suspendedBeforeEsc = suspendCalls[suspendCalls.length - 1] === true;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  await flush();
  check('Esc 取消录制：不调用 setShortcut',
    shortcutSet.payloads.length === 0, JSON.stringify(shortcutSet.payloads));
  check('Esc 取消录制：退出录制态恢复全局快捷键',
    suspendedBeforeEsc && suspendCalls[suspendCalls.length - 1] === false,
    JSON.stringify(suspendCalls));
  check('Esc 取消录制：界面回到当前快捷键', accelEl() === 'Ctrl+Alt+Y', JSON.stringify(accelEl()));

  // ---- 22. 快捷键键名规范化（acceleratorFromEvent 纯函数）----
  // 这些值直接决定注册给 globalShortcut 的字符串；'Ctrl+ ' 之类非法值会让
  // register 抛异常，所以每个都按 Electron 真实键名逐条验一遍。
  check('Space 归一化为 Ctrl+Space',
    acceleratorFromEvent({ key: ' ', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }) === 'Ctrl+Space');
  check('ArrowUp 归一化为 Ctrl+Up',
    acceleratorFromEvent({ key: 'ArrowUp', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }) === 'Ctrl+Up');
  check('加号归一化为 Ctrl+Plus',
    acceleratorFromEvent({ key: '+', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }) === 'Ctrl+Plus');
  // 减号没有 'Minus' 这个 Electron 键名，必须是字面量 '-'；映射错了 register 会失败
  // 并被上层误报成「该快捷键已被占用」。
  check('减号归一化为 Ctrl+-（Electron 无 Minus 键名）',
    acceleratorFromEvent({ key: '-', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }) === 'Ctrl+-');
  check('字母多修饰键归一化为 Ctrl+Alt+Y',
    acceleratorFromEvent({ key: 'y', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false }) === 'Ctrl+Alt+Y');
  check('功能键归一化为 Ctrl+F5',
    acceleratorFromEvent({ key: 'F5', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }) === 'Ctrl+F5');
  check('纯修饰键返回 null',
    acceleratorFromEvent({ key: 'Control', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }) === null);
  check('无修饰键返回 null',
    acceleratorFromEvent({ key: 'y', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }) === null);
  check('无法表达的键（媒体键）返回 null',
    acceleratorFromEvent({ key: 'AudioVolumeUp', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }) === null);

  // ---- 22. 悬浮条内闭环：可编辑 + 按钮集 + 折叠区 ----
  // 进入一次干净的 reviewing：先回 idle 清场，再喂四句定稿 + 切 reviewing
  const enterReviewing = async () => {
    fire('state', { state: 'idle', notice: null, truncated: false, origin: 'dictation' });
    await flush();
    fire('state', { state: 'warming', notice: null, truncated: false, origin: 'dictation' });
    await flush();
    fire('state', { state: 'listening', notice: null, truncated: false, origin: 'dictation' });
    for (const text of ['今天我们要讨论三件事', '第一件是采集', '第二件是识别', '第三件是润色']) {
      // 按 AsrPartial 的完整形状 fire：fire() 的载荷类型就是这个接口，
      // 少字段 TS 直接红（本文件既有的 partial 调用也都带全）。
      fire('partial', {
        text,
        sentenceEnd: true,
        recvAtMs: Date.now(),
        sentenceId: null,
        beginTime: null,
        endTime: null,
        words: [],
      });
    }
    fire('state', { state: 'reviewing', notice: null, truncated: false, origin: 'dictation' });
    await flush();
    return container;
  };

  await enterReviewing();
  const barEditor = () => container.querySelector<HTMLTextAreaElement>('[data-testid="bar-editor"]');
  check('reviewing 渲染可编辑区', barEditor() != null);
  check('编辑区初值为全文（每句一行）',
    barEditor()?.value === '今天我们要讨论三件事\n第一件是采集\n第二件是识别\n第三件是润色',
    JSON.stringify(barEditor()?.value));

  // 「打开应用」「存为常用语」都是头部的无文字图标（textContent 为空）。
  // 断言动作行文字时必须把它们剔掉，否则空串会混进来，也测不出它们是否真移走。
  const actionRowButtons = () =>
    Array.from(container.querySelectorAll('button'))
      .filter(
        (b) =>
          b.getAttribute('data-testid') !== 'bar-open-app' &&
          b.getAttribute('data-testid') !== 'bar-save-phrase'
      )
      .map((b) => b.textContent);
  check('动作行为 润色/复制/采纳/关闭（不含头部图标）',
    JSON.stringify(actionRowButtons()) === JSON.stringify(['润色', '复制', '采纳', '关闭']),
    JSON.stringify(actionRowButtons()));

  const openAppIcon = container.querySelector<HTMLButtonElement>('[data-testid="bar-open-app"]');
  check('头部有「打开应用」图标且 aria-label=title=bar.openApp',
    openAppIcon != null &&
      openAppIcon.getAttribute('aria-label') === '打开应用' &&
      openAppIcon.getAttribute('title') === '打开应用',
    JSON.stringify({
      present: openAppIcon != null,
      aria: openAppIcon?.getAttribute('aria-label'),
      title: openAppIcon?.getAttribute('title'),
    }));

  // Finding 4：上面的动作行断言按 testid 把 bar-open-app 过滤掉再比对，图标即便被
  // 挪回动作行也照样通过（过滤让它消失，比对自然成立）。这里补一条「位置」断言：
  // 图标不得位于动作行内，且其父节点必须是头部行。挪回动作行 → 两条同时破。
  const openAppEl = container.querySelector('[data-testid="bar-open-app"]');
  check('头部图标不在动作行内、父节点是头部（位置回归护栏）',
    openAppEl?.closest('[data-testid="bar-actions"]') === null &&
      openAppEl?.parentElement === container.querySelector('[data-testid="bar-head"]'),
    JSON.stringify({
      insideActions: openAppEl?.closest('[data-testid="bar-actions"]') != null,
      parentIsHead:
        openAppEl?.parentElement === container.querySelector('[data-testid="bar-head"]'),
    }));

  // 折叠区已移除：场景/语气常驻条底，进入 reviewing 立即可见。
  check('场景/语气常驻（reviewing 即可见，且无折叠开关）',
    container.querySelector('[data-testid="bar-scene"]') != null &&
      container.querySelector('[data-testid="bar-tone"]') != null &&
      container.querySelector('[data-testid="bar-advanced-toggle"]') == null);

  // 编辑 → 复制，复制内容必须是**编辑后**的文本
  copyCtl.text = null;
  historyUpdateCtl.payload = null;
  const ed = barEditor();
  if (ed) {
    // 不能直接 `ed.value = ...`：React 在 textarea 实例上装了 value tracker，
    // 直接赋值会被 tracker 记下，派发 input 时它认为「值没变」，onChange 不触发
    // （实测：编辑后的文本根本没进 state，复制拿到的还是原文）。
    // 走原型上的原生 setter 绕过实例那层劫持，再派发 input，React 才会认。
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(ed, '我改过的文本');
    ed.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await flush();
  clickButton('复制');
  await flush();
  check('复制取编辑后的文本', copyCtl.text === '我改过的文本', JSON.stringify(copyCtl.text));
  // 等这次复制的 IPC 真正收尾（剪贴板不可用时 real.copy 可到数秒）。它若一直悬着，
  // 其 setCopied(false) 会晚于下一段「采纳」的 setCopied(true) 落地，把 copied 打回
  // false —— Finding 1 的重复提示回归断言会因此变成假绿（revert 也测不出来）。
  await lastCopy;

  // 「编辑后回写同一条历史」的载荷断言：id 必须是 historySave 返回的 1（照抄
  // 假 bridge 的返回值，id 管线断了就能红），text 必须是**编辑后**的文本
  // （若 persistEdited 仍发未编辑的 fullText，此断言必红）。
  const updated = historyUpdateCtl.payload as { id: number; text: string } | null;
  check('编辑后回写历史：载荷为 { id: 1, text: 编辑后文本 }',
    updated?.id === 1 && updated?.text === '我改过的文本',
    JSON.stringify(updated));

  // ---- 23. 悬浮条内润色：上下分栏 + 流式 + 采纳取润色结果 ----
  await enterReviewing();
  polishCall.payload = null;
  clickButton('润色');
  await flush();
  // 显式断言绕开 TS 对对象属性的流收窄（上面刚赋过 null，否则被收窄成 never）
  const barPolishFired = polishCall.payload as
    { text: string; scene: Preset; tone: Preset; target?: 'bar' | 'studio' } | null;
  check('悬浮条发起的润色带 target=bar',
    barPolishFired?.target === 'bar', JSON.stringify(barPolishFired));
  // Finding 3：刚发起、还没有任何 delta（也无错误）时不能渲染空盒子白占布局。
  // 这是「面板只在有内容时渲染」的回归护栏，也解释了下面为何要先 fire delta
  // 再断言面板存在 —— 空面板阶段它本就应该不存在。
  check('未收到 delta 前不渲染空结果区（不占布局）',
    container.querySelector('[data-testid="bar-polish-output"]') == null);
  check('润色中「润色」按钮禁用',
    container.querySelector<HTMLButtonElement>('[data-testid="bar-polish"]')?.disabled === true);

  barPolishDelta.cb?.({ text: '润色后的' });
  barPolishDelta.cb?.({ text: '第一句' });
  await flush();
  check('有 delta 后出现下半结果区',
    container.querySelector('[data-testid="bar-polish-output"]') != null);
  check('润色 delta 追加到下半区',
    container.querySelector('[data-testid="bar-polish-output"]')?.textContent === '润色后的第一句',
    JSON.stringify(container.querySelector('[data-testid="bar-polish-output"]')?.textContent));

  barPolishDone.cb?.();
  await flush();
  copyCtl.text = null;
  adoptCall.payload = null;
  // 下面「采纳成功提示区」的断言需要 vp.copy 真的返回 true 才会走到 setHint。
  // 本机剪贴板不可用时（沙箱/远程会话，见前面 clipUsable）改成假成功，
  // 否则该断言在无剪贴板环境恒红、也就抓不到 Finding 1 的重复提示回归 ——
  // 与 section 6 的 clipUsable 分支同一理由。有剪贴板时仍走真实 IPC。
  if (!clipUsable) {
    bridge.copy = (text: string) => {
      copyCtl.text = text;
      return Promise.resolve(true);
    };
  }
  const toggleBefore = toggleCount;
  // 采纳链里含**真实的** vp.copy（跨进程 + 剪贴板写入，剪贴板被占用时能到数秒），
  // 所以这里一律用 waitFor 等条件成立，**不能**用固定 30ms 的 flush ——
  // 否则断言跑在实际结果之前，表现为间歇性红（本文件顶部 waitFor 的注释就是为此写的）。
  const adoptHintText = () =>
    container.querySelector('[data-testid="bar-hint-adopt"]')?.textContent ?? null;
  clickButton('采纳');
  await waitFor(() => toggleCount === toggleBefore + 1);
  // 同上：显式断言绕开流收窄，否则 adoptCall.payload 被判成 never
  const barAdopted = adoptCall.payload as
    { id?: number; polished: string; scene: string; tone: string } | null;
  check('采纳取润色结果（不是编辑区原文）', copyCtl.text === '润色后的第一句', JSON.stringify(copyCtl.text));
  check('采纳把润色结果回写历史',
    barAdopted?.polished === '润色后的第一句', JSON.stringify(barAdopted));

  // Finding 1 回归护栏：回写必须携带**本会话**的历史 id（假 historySave 返回 1）。
  // 丢掉 id 时这里是 undefined —— 主进程要么写不进去（NULL）、要么写到上一次
  // 「打开应用」留下的陈旧行上。断言按精确值 1，id 管线一断必红。
  check('采纳回写携带会话历史 id',
    barAdopted?.id === 1, JSON.stringify(barAdopted));

  // 采纳成功 = 真写回成功 → 悬浮条关闭，且**不该有任何提示**。
  // 旧形态（复制 + 兜底提示）已不存在：提示只在写回失败时出现。
  check('采纳成功时调用了写回通道', adoptPasteCtl.calls === 1, `${adoptPasteCtl.calls} 次`);
  check('采纳成功后关闭悬浮条', toggleCount === toggleBefore + 1, `${toggleBefore} → ${toggleCount}`);
  check('采纳成功不留任何提示节点',
    container.querySelectorAll('[data-testid^="bar-hint"]').length === 0,
    JSON.stringify(Array.from(container.querySelectorAll('[data-testid^="bar-hint"]')).map((n) => n.textContent)));

  // ---- 23b. 采纳写回失败：保留悬浮条 + 按 reason 给提示 ----
  // 「剪贴板从不还原」的兑现：失败时文本仍在剪贴板，提示必须告诉用户手动粘。
  // 每段都先 enterReviewing() 重走 idle → warming，借复位的 setHint('') 拿到干净提示；
  // 若某条红在「上一条的文案」上，说明复位块被动过，不是测试的问题。
  await enterReviewing();
  copyCtl.text = null;
  const toggleBeforeFail = toggleCount;
  adoptPasteCtl.result = { ok: false, reason: 'activate-failed' };
  adoptPasteCtl.calls = 0;
  clickButton('采纳');
  await waitFor(() => adoptHintText() === '自动写回失败，已复制到剪贴板，请手动粘贴');
  check('写回失败时确实调了写回通道', adoptPasteCtl.calls === 1, `${adoptPasteCtl.calls} 次`);
  check('写回失败时不关闭悬浮条', toggleCount === toggleBeforeFail,
    `${toggleBeforeFail} → ${toggleCount}`);
  check('写回失败时剪贴板已写好（不还原）', copyCtl.text !== null, JSON.stringify(copyCtl.text));
  check('activate-failed 给出通用失败提示',
    adoptHintText() === '自动写回失败，已复制到剪贴板，请手动粘贴',
    JSON.stringify(adoptHintText()));

  // permission 必须给**不同**的文案：它是唯一可操作的失败（去授权），
  // 若与通用文案混同，macOS 用户拿不到「该去授权」这个提示。
  await enterReviewing();
  adoptPasteCtl.result = { ok: false, reason: 'permission' };
  clickButton('采纳');
  await waitFor(() => adoptHintText() === '未获得辅助功能权限，无法自动写回。已复制到剪贴板，请手动粘贴');
  check('permission 给出可操作的不同文案',
    adoptHintText() === '未获得辅助功能权限，无法自动写回。已复制到剪贴板，请手动粘贴',
    JSON.stringify(adoptHintText()));

  // stale 同理，指向「目标窗口没了」这个具体原因。
  await enterReviewing();
  adoptPasteCtl.result = { ok: false, reason: 'stale' };
  clickButton('采纳');
  await waitFor(() => adoptHintText() === '目标窗口已关闭，已复制到剪贴板，请手动粘贴');
  check('stale 指出目标窗口已关闭',
    adoptHintText() === '目标窗口已关闭，已复制到剪贴板，请手动粘贴',
    JSON.stringify(adoptHintText()));

  // 复位，避免影响后面的用例（第 24 段起还会复用这棵 App 树）
  adoptPasteCtl.result = { ok: true };

  // ---- 24. 无预设路径：runPolish 早退必须给明确提示、且不渲染结果区 ----
  // 既有假 bridge 的 polishPresets 恒返回预设，runPolish 里 `!scene || !tone` 的
  // bar.err.noPresets 分支从未被走到。按本文件既有做法（见 Studio 的 studioBridge）
  // 另起一棵 App 树 + 独立 bridge：从既有 bridge 派生，只把 polishPresets 覆盖成
  // 空预设，并给这棵树自己的 state/partial 监听器（否则会与上面那棵树互相覆盖）。
  const npListeners: {
    state?: (s: SessionSnapshot) => void;
    partial?: (p: AsrPartial) => void;
  } = {};
  const noPresetBridge = {
    ...bridge,
    onState: (cb: NonNullable<(typeof npListeners)['state']>) => {
      npListeners.state = cb;
      return () => {};
    },
    onPartial: (cb: NonNullable<(typeof npListeners)['partial']>) => {
      npListeners.partial = cb;
      return () => {};
    },
    polishPresets: () =>
      Promise.resolve({ scenes: [], tones: [], defaultSceneId: null }),
    // 这棵树不测润色流。三个监听器必须显式占住空实现：bridge 的 onPolishDelta
    // 是**单槽** holder（barPolishDelta.cb），这棵树若继承它，挂载时就会把主树的
    // 回调挤掉 —— 第 25 段给主树送 delta 会送到这棵树来，主树的 polishOut 永远为空。
    onPolishDelta: () => () => {},
    onPolishDone: () => () => {},
    onPolishError: () => () => {},
  };
  const npContainer = document.createElement('div');
  document.body.appendChild(npContainer);
  createRoot(npContainer).render(
    <App
      bridge={noPresetBridge}
      // 不给真引擎：本段只验 runPolish 的早退，采集一律空跑。
      createCapture={() => ({ start: async () => {}, stop: async () => {} })}
    />
  );
  await flush();
  const npFire = <K extends keyof typeof npListeners>(
    channel: K,
    payload: Parameters<NonNullable<(typeof npListeners)[K]>>[0]
  ) => {
    (npListeners[channel] as ((p: typeof payload) => void) | undefined)?.(payload);
  };

  // 与 enterReviewing 同款顺序驱动这棵树：idle → warming → listening → 定稿 → reviewing
  npFire('state', { state: 'idle', notice: null, truncated: false, origin: 'dictation' });
  await flush();
  npFire('state', { state: 'warming', notice: null, truncated: false, origin: 'dictation' });
  await flush();
  npFire('state', { state: 'listening', notice: null, truncated: false, origin: 'dictation' });
  npFire('partial', {
    text: '无预设也要给提示',
    sentenceEnd: true,
    recvAtMs: Date.now(),
    sentenceId: null,
    beginTime: null,
    endTime: null,
    words: [],
  });
  npFire('state', { state: 'reviewing', notice: null, truncated: false, origin: 'dictation' });
  await flush();
  check('无预设：进入 reviewing 后可编辑区可见',
    npContainer.querySelector('[data-testid="bar-editor"]') != null);

  npContainer.querySelector<HTMLButtonElement>('[data-testid="bar-polish"]')?.click();
  await flush();
  // (a) 早退必须看得见：hint 落到条底的提示区（bar-hint-adopt），文案取 zh-CN 词条
  check('无预设时显示 bar.err.noPresets 提示',
    npContainer.textContent?.includes('未能加载润色预设，请稍后重试') === true,
    JSON.stringify(npContainer.textContent));
  // (b) 早退证据：runPolish 在 setPolishing 之前就返回，润色结果区不该出现
  check('无预设时 runPolish 早退，不渲染润色结果区',
    npContainer.querySelector('[data-testid="bar-polish-output"]') == null);

  // ---- 25. 常用语选择器：搜索 / 键盘导航 / Enter 选中 / Esc 关闭 / 占位 ----
  // 常用语一路是 idle → phrases，正文完全来自 phraseText，**不能**在进 phrases 之前
  // 经过 warming —— warming 复位块会清空 committed，历史 effect 就会在 fullText 为空
  // 的早退处返回，origin 门禁再也测不出来。下面先用 enterReviewing() 造出一段真实
  // 听写（committed 非空、历史已保存一次）作为判别前提，再从 idle 直接进 phrases。
  phraseRows = [
    { id: 1, title: '问候', text: '您好，收到您的反馈，我先看一下。', created_at: 2, updated_at: 2, used_at: null },
    { id: 2, title: '收尾', text: '有问题随时找我。', created_at: 1, updated_at: 1, used_at: null },
  ];
  const enterPhrases = async () => {
    fire('state', { state: 'idle', notice: null, truncated: false, origin: 'dictation' });
    await flush();
    fire('state', { state: 'phrases', notice: null, truncated: false, origin: 'dictation' });
    await waitFor(() => container.querySelector('[data-testid="phrase-item"]') != null);
    return container;
  };
  const items = () => Array.from(container.querySelectorAll('[data-testid="phrase-item"]'));
  const activeIndex = () => items().findIndex((n) => n.getAttribute('data-active') === 'true');

  // 先把「一次正常听写」走到 reviewing：committed 非空、历史真的保存过一次。
  // 这是下面「常用语不落历史」能真正判别的前提 —— 旧版先跑 idle → warming → idle，
  // warming 复位块会把 committed 清空，历史 effect 在 `fullText.trim().length === 0`
  // 的早退处就返回了，删掉 origin 门禁也照样绿，那条断言等于没写。
  // 这条听写断言同时是「机制本身没坏」的对照（control）。
  // failCapture 必须复位：第 8 段把它置成 true 后一直没清，采集起点会直接抛错，
  // 混进 enterReviewing 的 warming 会把整段带偏。
  failCapture = false;
  await enterReviewing();
  check('听写来的 reviewing 照旧落历史（origin=dictation）',
    historySaveCtl.payload != null &&
      (historySaveCtl.payload as { text: string }).text.includes('今天我们要讨论三件事'),
    JSON.stringify(historySaveCtl.payload));
  // 前提已坐实，从这里起只盯「常用语这条路有没有再写一次历史」。
  historySaveCtl.payload = null;

  // 进 phrases **不经过 warming**（enterPhrases 只 fire idle → phrases）：真实里上一段
  // 听写结束后，常用语就是从 idle 直接进来的，committed 仍留着上一段听写的文本 ——
  // 正是「fullText 非空」的真实形态，origin 门禁在这条路上才承重。
  await enterPhrases();
  // 「phrases 态绝不启动采集」（spec §1.6）：清掉标志位再进一次态，断言它保持 false。
  // 这是「不说话直接选一条」不产生任何识别费用的唯一证据。
  captureStarted = false;
  await enterPhrases();
  check('phrases 态不启动采集（不建 ASR 会话、不产生识别费用）',
    captureStarted === false, String(captureStarted));
  check('选择器渲染搜索框与两条常用语',
    container.querySelector('[data-testid="phrase-search"]') != null && items().length === 2,
    JSON.stringify(items().map((n) => n.textContent)));
  check('默认高亮第一条', activeIndex() === 0, String(activeIndex()));

  const search = container.querySelector<HTMLInputElement>('[data-testid="phrase-search"]');
  const typeSearch = (v: string) => {
    // 与 bar-editor 同一坑：React 在 input 上装了 value tracker，直接赋值会被
    // 认为「值没变」而不触发 onChange。必须走原型上的原生 setter。
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(search, v);
    search?.dispatchEvent(new Event('input', { bubbles: true }));
  };

  typeSearch('收尾');
  await flush();
  check('输入即筛选（标题命中）', items().length === 1, String(items().length));

  typeSearch('反馈');
  await flush();
  check('输入即筛选（正文也匹配）', items().length === 1, String(items().length));

  typeSearch('不存在的词');
  await flush();
  check('无匹配时显示占位、不显示条目',
    items().length === 0 && container.querySelector('[data-testid="phrases-empty"]') != null,
    JSON.stringify(container.querySelector('[data-testid="phrases-empty"]')?.textContent));

  typeSearch('');
  await flush();
  check('清空查询后恢复全部', items().length === 2, String(items().length));

  // 方向键：↓ 到第二条、↑ 回第一条
  search?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await flush();
  check('↓ 移到第二条', activeIndex() === 1, String(activeIndex()));
  search?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  await flush();
  check('↑ 回到第一条', activeIndex() === 0, String(activeIndex()));

  // Enter 选中：正文进编辑区、记一次 touch、状态机切 reviewing
  usePhraseCalls = 0;
  touchedIds.length = 0;
  search?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
  check('Enter 调了一次 usePhrase', usePhraseCalls === 1, String(usePhraseCalls));
  check('Enter 记了一次「被用过」（id 与高亮项一致）',
    JSON.stringify(touchedIds) === JSON.stringify([1]), JSON.stringify(touchedIds));

  fire('state', { state: 'reviewing', notice: null, truncated: false, origin: 'phrase' });
  await flush();
  const phraseEditor = () => container.querySelector<HTMLTextAreaElement>('[data-testid="bar-editor"]');
  check('选中后编辑区内容是那条常用语的正文（不是空的 fullText）',
    phraseEditor()?.value === '您好，收到您的反馈，我先看一下。',
    JSON.stringify(phraseEditor()?.value));

  // 「常用语不落历史」（spec §2.3）：origin=phrase 且 fullText 非空（上一段听写的
  // committed 还在）时**不得**再调 historySave。payload 的基线已在进 phrases 前清零，
  // 这里若删掉 origin 门禁，历史 effect 会真的写一次，这条必红。
  check('常用语来的 reviewing 不落新历史（origin=phrase，fullText 非空）',
    historySaveCtl.payload === null, JSON.stringify(historySaveCtl.payload));

  // Task 1 遗留：钉住 store.js 的 resolvePolishTarget 三态契约 ——
  // **显式 id=null**（＝本次没有历史行，主进程不回落 pendingHistoryId）与
  // 整个 id 字段缺省（＝Studio 一路，回落）是两种语义，必须能从载荷上区分开。
  // 常用语一路不写历史，historyIdRef 由 phrases 入口复位为 null，正是这条路径。
  // 要先有润色结果 adopt 才会走回写分支，所以先点润色、再灌一段 delta。
  clickButton('润色');
  await flush();
  barPolishDelta.cb?.({ text: '常用语的润色结果' });
  await flush();
  adoptCall.payload = null;
  clickButton('采纳');
  await waitFor(() => adoptCall.payload != null);
  // 显式断言绕开 TS 对对象属性的流收窄（上面刚赋过 null，否则被收窄成 never）
  const phraseAdopted = adoptCall.payload as { id?: number | null; polished: string } | null;
  check('常用语采纳回写携带显式 null id（不回落 pendingHistoryId）',
    phraseAdopted != null && 'id' in phraseAdopted && phraseAdopted.id === null,
    JSON.stringify(phraseAdopted));
  await flush();

  // Esc 关闭选择器
  await enterPhrases();
  togglePhrasesCalls = 0;
  container
    .querySelector<HTMLInputElement>('[data-testid="phrase-search"]')
    ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await flush();
  check('Esc 调了一次 togglePhrases', togglePhrasesCalls === 1, String(togglePhrasesCalls));

  // 空库占位：给「去存一条」的引导，而不是「没有匹配」
  phraseRows = [];
  await enterPhrases();
  check('空库显示引导文案（不是「没有匹配」）',
    container.querySelector('[data-testid="phrases-empty"]')?.textContent ===
      '还没有常用语。在结果里点书签图标存一条。',
    JSON.stringify(container.querySelector('[data-testid="phrases-empty"]')?.textContent));

  // ---- 26. 条内「存为常用语」：存入的是有效文本，且不打断 ----
  await enterReviewing();
  phraseSaveCtl.payload = null;
  // 制造「编辑区被改过、但没有润色结果」的局面，验证存的是编辑后的原文
  const ed2 = container.querySelector<HTMLTextAreaElement>('[data-testid="bar-editor"]');
  if (ed2) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(ed2, '第一行标题\n第二行正文');
    ed2.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await flush();

  const saveBtn = container.querySelector<HTMLButtonElement>('[data-testid="bar-save-phrase"]');
  check('reviewing 头部有「存为常用语」图标且 aria-label=title',
    saveBtn != null &&
      saveBtn.getAttribute('aria-label') === '存为常用语' &&
      saveBtn.getAttribute('title') === '存为常用语',
    JSON.stringify({ present: saveBtn != null, aria: saveBtn?.getAttribute('aria-label') }));

  // 位置回归护栏：与「打开应用」同一套理由 —— 必须不在动作行内、父节点是头部
  check('「存为常用语」不在动作行内、父节点是头部（位置回归护栏）',
    saveBtn?.closest('[data-testid="bar-actions"]') === null &&
      saveBtn?.parentElement === container.querySelector('[data-testid="bar-head"]'),
    JSON.stringify({
      insideActions: saveBtn?.closest('[data-testid="bar-actions"]') != null,
      parentIsHead: saveBtn?.parentElement === container.querySelector('[data-testid="bar-head"]'),
    }));

  saveBtn?.click();
  await waitFor(() => phraseSaveCtl.payload != null);
  // waitFor 的判据是「phrasesSave 已被调用」，而它同步就成立；setHint 的渲染落在
  // 更晚的一轮调度里。多等一拍再断言提示节点，否则会拿不到节点误判失败。
  await flush();
  const saved = phraseSaveCtl.payload as { title: string; text: string } | null;
  check('存的是编辑后的原文（无润色时）',
    saved?.text === '第一行标题\n第二行正文', JSON.stringify(saved));
  check('标题自动取第一个非空行', saved?.title === '第一行标题', JSON.stringify(saved?.title));
  check('保存成功给出轻提示（不关闭悬浮条、不占错误气泡）',
    container.querySelector('[data-testid="bar-hint-adopt"]')?.textContent === '已存为常用语' &&
      container.querySelector('[data-testid="bar-editor"]') != null,
    JSON.stringify(container.querySelector('[data-testid="bar-hint-adopt"]')?.textContent));

  // 「有润色存润色」的另一半。上面那条在「无润色结果」下跑：此时 effectiveText 与
  // 编辑区原文恒等，存的是哪一个都绿，等于没测。这里先制造一段润色结果，再存，
  // 断言 phrasesSave 收到的是**润色文本**而不是编辑区原文。
  phraseSaveCtl.payload = null;
  await enterReviewing();
  clickButton('润色');
  await flush();
  barPolishDelta.cb?.({ text: '润色后的常用语正文' });
  await flush();
  // 前提：润色文本确实与编辑区原文不同，否则下面那条断言分辨不出两者。
  check('有润色结果时编辑区原文与润色文本不同（下一条断言的前提）',
    barEditor()?.value !== '润色后的常用语正文', JSON.stringify(barEditor()?.value));
  container.querySelector<HTMLButtonElement>('[data-testid="bar-save-phrase"]')?.click();
  await waitFor(() => phraseSaveCtl.payload != null);
  const savedPolished = phraseSaveCtl.payload as { title: string; text: string } | null;
  check('有润色时存的是润色文本（不是编辑区原文）',
    savedPolished?.text === '润色后的常用语正文', JSON.stringify(savedPolished));

  // ---- 26b. 上一段结果的一次性提示不得跟进选择器（真机反馈）----
  // 「已存为常用语」原本留在条底：idle 下整条不渲染（组件直接 return null），这条提示
  // 只在 warming 复位块里清，于是再打开选择器时它又出现在搜索框下面，像是刚刚发生的事。
  // 判据必须同时看「进之前挂着」与「进之后没了」—— 只看后者的话，提示若压根没被设置
  // （保存路径断了）也一样绿，等于没测。
  phraseRows = [
    { id: 1, title: '问候', text: '您好，收到您的反馈，我先看一下。', created_at: 2, updated_at: 2, used_at: null },
  ];
  const hintNode = () =>
    container.querySelector('[data-testid="bar-hint-adopt"]')?.textContent ?? null;
  await flush(); // setHint 落在 phrasesSave 之后一轮调度里（见上面那条 waitFor 的注释）
  check('（前提）保存常用语后条底挂着「已存为常用语」',
    hintNode() === '已存为常用语', JSON.stringify(hintNode()));
  await enterPhrases();
  check('进选择器后不再显示上一段的一次性提示',
    hintNode() === null, JSON.stringify(hintNode()));

  // ---- 26c. 条不再渲染时必须恢复穿透（真机反馈：Mac 上 Chrome 右下角的按钮点不动）----
  // 条是一张常驻的置顶窗口，位置固定在屏幕右下角。鼠标移入时它**临时关掉穿透**（否则条里
  // 的按钮自己就点不到），而「移出」是靠根节点上的 onMouseLeave 收的 —— 条不再渲染（回
  // idle）时元素是被直接卸载的，不会再补一个 mouseleave，hovering 就永远停在 true：窗口
  // 看不见、却一直在吃掉它那块矩形里的点击。用户看到的就是「鼠标移上去不变手型、按钮点
  // 不动」，且只在右下角那一块（560×148）失效。
  const barRoot = () => container.querySelector('[data-state]');
  const lastPassthrough = () => passthroughCalls[passthroughCalls.length - 1];
  passthroughCalls.length = 0;
  barRoot()?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  await flush();
  check('（前提）鼠标移入条时关掉穿透（条里的按钮才点得到）',
    lastPassthrough() === false, JSON.stringify(passthroughCalls));
  fire('state', { state: 'idle', notice: null, truncated: false, origin: 'dictation' });
  await flush();
  check('条回到 idle（不再渲染）后必须恢复穿透',
    lastPassthrough() === true, JSON.stringify(passthroughCalls));

  // derivePhraseTitle 的边界（纯函数，直接验）
  check('derivePhraseTitle：空串 → 空', derivePhraseTitle('') === '', JSON.stringify(derivePhraseTitle('')));
  check('derivePhraseTitle：全空白 → 空',
    derivePhraseTitle('   \n\n  ') === '', JSON.stringify(derivePhraseTitle('   \n\n  ')));
  check('derivePhraseTitle：跳过前导空行取第一个非空行',
    derivePhraseTitle('\n\n  第二行才是标题  \n第三行') === '第二行才是标题',
    JSON.stringify(derivePhraseTitle('\n\n  第二行才是标题  \n第三行')));
  check('derivePhraseTitle：恰好 40 字符不截断',
    derivePhraseTitle('a'.repeat(40)) === 'a'.repeat(40));
  check('derivePhraseTitle：41 字符截断到 40 并补省略号',
    derivePhraseTitle('a'.repeat(41)) === 'a'.repeat(40) + '…',
    JSON.stringify(derivePhraseTitle('a'.repeat(41))));
  // 纯 ASCII 用例挡不住「码点截断退回 UTF-16 截断」的回归：'😀' 在 UTF-16 里占
  // 两个单元，.slice(0,40) 会切出 20 个 emoji 或半个代理对；按码点才是 40 个。
  check('derivePhraseTitle：按码点截断（emoji 不被 UTF-16 拆开）',
    derivePhraseTitle('😀'.repeat(41)) === '😀'.repeat(40) + '…',
    JSON.stringify(derivePhraseTitle('😀'.repeat(41))));

  // ---- 27. Studio「常用语」页：列表 / 编辑 / 新建 / 删除 ----
  // 另起一棵树，与第 24 段同款理由：不让上面的容器状态互相干扰。
  const phContainer = document.createElement('div');
  document.body.appendChild(phContainer);
  createRoot(phContainer).render(<Studio bridge={studioBridge} />);
  await flush();

  const navPhrases = phContainer.querySelector<HTMLButtonElement>('[data-testid="studio-nav-phrases"]');
  check('Studio 导航有「常用语」一项',
    navPhrases != null && navPhrases.textContent?.includes('常用语') === true,
    JSON.stringify(navPhrases?.textContent));

  navPhrases?.click();
  await waitFor(() => phContainer.querySelector('[data-testid="phrase-list-item"]') != null);
  check('常用语页渲染出已有条目',
    phContainer.querySelectorAll('[data-testid="phrase-list-item"]').length === 1,
    String(phContainer.querySelectorAll('[data-testid="phrase-list-item"]').length));

  // 选中一条 → 详情回填
  phContainer.querySelector<HTMLElement>('[data-testid="phrase-list-item"]')?.click();
  await flush();
  check('选中后详情回填标题与正文',
    phContainer.querySelector<HTMLInputElement>('[data-testid="phrase-edit-title"]')?.value === '问候' &&
      phContainer.querySelector<HTMLTextAreaElement>('[data-testid="phrase-edit-text"]')?.value === '您好，收到您的反馈。',
    JSON.stringify({
      title: phContainer.querySelector<HTMLInputElement>('[data-testid="phrase-edit-title"]')?.value,
      text: phContainer.querySelector<HTMLTextAreaElement>('[data-testid="phrase-edit-text"]')?.value,
    }));

  // 删除
  phContainer.querySelector<HTMLButtonElement>('[data-testid="phrase-delete"]')?.click();
  await waitFor(() => phContainer.querySelectorAll('[data-testid="phrase-list-item"]').length === 0);
  check('删除后列表清空且调了 phrasesDelete',
    phraseCtl.deleted.includes(1) &&
      phContainer.querySelectorAll('[data-testid="phrase-list-item"]').length === 0,
    JSON.stringify(phraseCtl.deleted));

  // 新建：空表单 + 保存
  phraseCtl.saved = null;
  phContainer.querySelector<HTMLButtonElement>('[data-testid="phrase-new"]')?.click();
  await flush();
  check('新建时详情表单是空的、且没有删除按钮',
    phContainer.querySelector<HTMLInputElement>('[data-testid="phrase-edit-title"]')?.value === '' &&
      phContainer.querySelector('[data-testid="phrase-delete"]') == null);
  check('内容为空时保存禁用',
    phContainer.querySelector<HTMLButtonElement>('[data-testid="phrase-save"]')?.disabled === true);

  const phText = phContainer.querySelector<HTMLTextAreaElement>('[data-testid="phrase-edit-text"]');
  if (phText) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(phText, '手写的一条常用语');
    phText.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await flush();
  phContainer.querySelector<HTMLButtonElement>('[data-testid="phrase-save"]')?.click();
  await waitFor(() => phraseCtl.saved != null);
  // 上面那句 `phraseCtl.saved = null` 会把属性收窄成 null，而闭包里的赋值不在 TS 的
  // 流分析里 —— 直接读 .text 会得到 never。与第 26 段同款做法：取本地常量时断言回类型。
  const phSaved = phraseCtl.saved as { title: string; text: string } | null;
  check('新建保存调 phrasesSave（标题留空用占位名）',
    phSaved?.text === '手写的一条常用语' && phSaved?.title === '未命名',
    JSON.stringify(phSaved));

  // ---- 28. 设置页出现第二块快捷键（主块不受影响）----
  const setContainer = document.createElement('div');
  document.body.appendChild(setContainer);
  createRoot(setContainer).render(<SettingsView bridge={settingsBridge} />);
  await waitFor(() => setContainer.querySelector('[data-testid="settings-phrase-shortcut"]') != null);
  check('设置页有常用语快捷键块，且主块与录制按钮都在',
    setContainer.querySelector('[data-testid="settings-phrase-shortcut"]') != null &&
      setContainer.querySelector('[data-testid="settings-phrase-shortcut-record"]') != null &&
      setContainer.querySelector('[data-testid="settings-shortcut"]') != null,
    JSON.stringify(setContainer.textContent));

  // 上面那条只断言「三个 testid 都在」，抓不住这次重构的要点：两个槽位必须各自读写。
  // 若 phrases 块的 read 回落成 getShortcut，或 hintKey 返回主块提示，它依然全绿。
  // 所以这里把两个槽位**各自**渲染出的加速键与提示文案都钉住。
  const slotText = (id: string) =>
    setContainer.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
  // 提示 <span> 是 block（statusRow 的父节点）的最后一个元素子节点，当前标记没有 testid。
  const slotHint = (id: string) =>
    setContainer.querySelector(`[data-testid="${id}"]`)?.parentElement?.parentElement
      ?.lastElementChild?.textContent ?? null;

  const phrasesAccelShown = await waitFor(
    () => slotText('settings-phrase-shortcut') === 'Ctrl+Alt+Space'
  );
  check('常用语槽位渲染 getPhraseShortcut 的值（不读主槽位）',
    phrasesAccelShown, JSON.stringify(slotText('settings-phrase-shortcut')));
  check('主槽位仍渲染自己的值（getShortcut）',
    slotText('settings-shortcut') === 'Ctrl+Shift+Space',
    JSON.stringify(slotText('settings-shortcut')));

  const mainHint = slotHint('settings-shortcut');
  const phrasesHint = slotHint('settings-phrase-shortcut');
  check('两个槽位的提示文案不同（hintKey 没串槽）',
    mainHint != null && phrasesHint != null && mainHint !== phrasesHint,
    JSON.stringify({ main: mainHint, phrases: phrasesHint }));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  for (const f of failed) console.log(`  FAIL ${f.name} ${f.detail}`);
  return { ok: failed.length === 0, failed: failed.length, total: results.length };
}
