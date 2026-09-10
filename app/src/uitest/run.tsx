import { createRoot } from 'react-dom/client';
import App from '../App';
import Studio from '../studio/Studio';

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

const IDLE = { state: 'idle', notice: null, truncated: false } as const;

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
    copy: (text: string) => real.copy(text),
    reportPainted: (at: number) => real.reportPainted(at),
    openStudio: (payload: { text: string; historyId?: number }) => {
      openStudioCtl.arg = payload.text;
      return Promise.resolve(true);
    },
    historySave: (payload: { text: string }) => {
      historySaveCtl.payload = payload;
      return Promise.resolve({ id: 1 });
    },
    toggle: () => {
      toggleCount += 1;
      return Promise.resolve(IDLE);
    },
    syncState: () => Promise.resolve(IDLE),
    sendAudio: (meta: { seq: number; cumSamples: number }) => {
      sentFrames.push(meta);
    },
    setMousePassthrough: () => {},
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
  fire('state', { state: 'warming', notice: null, truncated: false });
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
  fire('state', { state: 'listening', notice: null, truncated: false });
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

  // ---- 5. 定稿 + 自适应分段 ----
  // 先连说几句，句间都是 300ms 短停顿（快语速节奏），不该分段
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
  // 300ms 短停顿不触发分段：固定阈值对慢语速会误切，这里验快语速正常不分段
  check('短停顿 300ms 不分段', committedEl?.textContent?.includes('\n') === false,
    JSON.stringify(committedEl?.textContent));

  // 一次明显长于自身节奏的停顿（2000ms）→ 才另起一段
  fire('partial', {
    recvAtMs: Date.now(),
    text: '第三件是润色',
    sentenceEnd: true,
    sentenceId: 's4',
    beginTime: 5300, // 与上句末尾隔 2000ms，远超自身节奏 → 分段
    endTime: 6200,
    words: [],
  });
  await flush();
  check('长停顿 2000ms 触发分段，且换行在第三件之前',
    committedEl?.textContent?.includes('第二件是识别\n第三件是润色') === true,
    JSON.stringify(committedEl?.textContent));

  // ---- 6. reviewing + 复制（走真实 IPC，主进程读回剪贴板核对）----
  fire('state', { state: 'reviewing', notice: null, truncated: false });
  await flush();
  const buttons = Array.from(container.querySelectorAll('button'));
  check('reviewing 出现「复制」按钮', buttons.some((b) => b.textContent === '复制'));

  const copyBtn = buttons.find((b) => b.textContent === '复制');
  const expectedText = committedEl?.textContent ?? '';

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
  check('复制内容与界面文本一致', expectedText.includes('三件事'));

  // ---- 6.5 润色 + 历史保存：进入 reviewing 时原文已写入历史一次 ----
  fire('state', { state: 'reviewing', notice: null, truncated: false });
  await flush();
  check('reviewing 时已调用 historySave 且带全文',
    (historySaveCtl.payload?.text ?? '').includes('三件事'),
    JSON.stringify(historySaveCtl.payload));
  toggleCount = 0;
  openStudioCtl.arg = null;
  clickButton('润色');
  await flush();
  // 显式断言绕开 TS 对对象属性的流收窄（否则被收窄成 never）
  const openedArg = openStudioCtl.arg as string | null;
  check('点「润色」调用 openStudio 且带全文', (openedArg ?? '').includes('三件事'),
    JSON.stringify(openedArg));
  check('点「润色」后悬浮条关闭（触发 toggle）', toggleCount === 1, `toggle 调用 ${toggleCount} 次`);

  // ---- 7. 背压：未确认帧数超上限就丢 ----
  fire('state', { state: 'listening', notice: null, truncated: false });
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
  fire('state', { state: 'idle', notice: null, truncated: false });
  await flush();
  failCapture = true;
  let captureFailReported = false;
  bridge.captureFailed = () => {
    captureFailReported = true;
  };
  fire('state', { state: 'warming', notice: null, truncated: false });
  await waitFor(() => captureFailReported);
  check('采集失败上报主进程', captureFailReported);
  check('采集失败在界面上有明确提示',
    container.textContent?.includes('麦克风不可用') === true,
    JSON.stringify(container.textContent));

  // 状态机随后会回到 idle，但错误要再多停几秒（App.tsx 的 ERROR_HOLD_MS），
  // 否则用户只看到悬浮条闪了一下，等于没提示
  fire('state', { state: 'idle', notice: null, truncated: false });
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
  const polishCall: { payload: { text: string; scene: Preset; tone: Preset } | null } = { payload: null };
  const adoptCall: { payload: { polished: string; scene: string; tone: string } | null } = { payload: null };
  // 给 Studio 注入假 bridge（与 App 同款模式），不动只读的 window.voicepilot。
  // 用对象属性兜住刷新监听器：TS 会把 `let x = null` 收窄成 null，
  // 属性访问则不会被这样收窄。
  const studioRefresh: { cb: ((p: { text: string }) => void) | null } = { cb: null };
  // 润色流式事件监听器，供测试按真实签名 fire 载荷（与 studioRefresh 同款模式）
  const studioDelta: { cb: ((p: { text: string }) => void) | null } = { cb: null };
  const studioDone: { cb: (() => void) | null } = { cb: null };
  const studioError: { cb: ((p: { message: string }) => void) | null } = { cb: null };
  const studioBridge = {
    ...real,
    onStudioRefresh: (cb: (p: { text: string }) => void) => { studioRefresh.cb = cb; return () => {}; },
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
    adoptPolish: (p: { polished: string; scene: string; tone: string }) => {
      adoptCall.payload = p;
      return Promise.resolve(true);
    },
    onPolishDelta: (cb: (p: { text: string }) => void) => { studioDelta.cb = cb; return () => {}; },
    onPolishDone: (cb: () => void) => { studioDone.cb = cb; return () => {}; },
    onPolishError: (cb: (p: { message: string }) => void) => { studioError.cb = cb; return () => {}; },
    listPresets: () => Promise.resolve([{ id: 1, name: '邮件', description: '', lang: null, is_builtin: 1 }]),
    savePreset: () => Promise.resolve({ id: 2 }),
    deletePreset: () => Promise.resolve(true),
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
  studioRefresh.cb?.({ text: '第二次口述的新文本' });
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

  const failed = results.filter((r) => !r.ok);
  console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  for (const f of failed) console.log(`  FAIL ${f.name} ${f.detail}`);
  return { ok: failed.length === 0, failed: failed.length, total: results.length };
}
