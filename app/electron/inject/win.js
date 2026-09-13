import koffi from 'koffi';
import { app } from 'electron';

/**
 * Windows 注入实现。
 *
 * ⚠️ 顶层绝不 koffi.load()：index.js 静态 import 了本文件，macOS 上
 * koffi.load('user32.dll') 会在应用启动时抛。所有动态库句柄都在 lib() 里惰性建。
 */

const SW_RESTORE = 9;
const VK_CONTROL = 0x11;
const VK_V = 0x56;
const VK_A = 0x41;
const VK_Z = 0x5a;
const KEYEVENTF_KEYUP = 0x0002;
// 置前是异步的：SetForegroundWindow 返回时目标未必已经真的拿到前台。
// 60ms 是起点不是承诺（spec §8 第 7 条），真机不合就在 Task 8 调。
const ACTIVATE_WAIT_MS = 60;
// 等待期间的探测间隔（仅诊断用，不参与判定）。
const PROBE_INTERVAL_MS = 10;

/**
 * 诊断开关。这条路径**没法自动测**（真实置前/粘贴），所以真机排障时唯一的
 * 信息来源就是它。用 `VP_INJECT_DEBUG=1` 打开，做法与仓库里既有的
 * `VP_ASR_DEBUG` / `VP_OPEN_DIAG` 一致。
 */
const DEBUG = process.env.VP_INJECT_DEBUG === '1';

// 诊断用：换掉「要发什么键」，用来区分失败发生在哪一段。
//   type      —— 只发一个字面字符 z：若它进不去，说明按键**根本没被目标收到**
//   selectall —— 发 Ctrl+A：在 Word/浏览器/终端里都有可见效果且不破坏内容
// 不设 = 现状（Ctrl+V）。
// （曾有个 scancode 模式用来验「扫描码传 0 被丢弃」—— 真机已证伪：带真实扫描码同样
//   不生效，真正根因是修饰键丢失，见 INPUT 结构处。已删，不留死代码。）
//
// ⚠️ 与仓库里其它只打日志的 `VP_*` 开关不同，这个开关**会真的改产品行为**：
//   `type` 会往用户当前的前台应用里敲进一个 z；
//   `selectall` 会发 Ctrl+A，且**照样按 ok 上报**（剪贴板文本根本没被粘贴）。
// 所以它必须**双闸门**：既要 `VP_INJECT_DEBUG=1`，又必须是非打包构建
// （`!app.isPackaged`）。**交给试用者的包里永远不可达** —— 不要放宽这两道中的任何一道。
const PROBE = DEBUG && !app.isPackaged ? (process.env.VP_INJECT_PROBE ?? '') : '';

/** 等待上限（毫秒）。`VP_INJECT_WAIT_MS=<n>` 可在不重新打包的前提下试不同值。 */
function waitMs() {
  const n = Number(process.env.VP_INJECT_WAIT_MS);
  return Number.isFinite(n) && n >= 0 ? n : ACTIVATE_WAIT_MS;
}

function dbg(...args) {
  if (DEBUG) console.log('[注入]', ...args);
}

/**
 * GUITHREADINFO：只读某线程的焦点窗口。字段顺序/对齐必须与 Win32 一致，
 * x64 下 sizeof 应为 **72**（已在真机确认）。
 */
const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const GUITHREADINFO = koffi.struct('GUITHREADINFO', {
  cbSize: 'uint32',
  flags: 'uint32',
  hwndActive: 'uintptr_t',
  hwndFocus: 'uintptr_t',
  hwndCapture: 'uintptr_t',
  hwndMenuOwner: 'uintptr_t',
  hwndMoveSize: 'uintptr_t',
  hwndCaret: 'uintptr_t',
  rcCaret: RECT,
});

/**
 * x64 下必须是 72。导出给自测断言 —— 与 `INPUT_SIZE` 同款理由：`cbSize` 写错时
 * `GetGUIThreadInfo` 只会返回 false，是一条**静默的假阴性**，肉眼看不出来。
 */
export const GUITHREADINFO_SIZE = koffi.sizeof(GUITHREADINFO);

/**
 * SendInput 的 INPUT 结构。
 *
 * ⚠️ 为什么**必须**用 SendInput、不能用四次独立的 keybd_event（这是真机踩出来的）：
 * modifier 与键必须**原子**投递。四次独立调用时，Ctrl 的按下经常还没生效，V/A 就已经
 * 被目标处理了 —— 于是 Ctrl+V 退化成裸字符 V、Ctrl+A 退化成裸 A。真机现象：
 * 「Word 里冒出一个 A」「记事本碰巧行，Word/浏览器/终端时灵时不灵」。
 * SendInput 一次调用把全部事件作为**一批**放进输入流，修饰键状态是确定的。
 *
 * 规划早期刻意选了 keybd_event 以避开 INPUT 的联合体对齐 —— 那个取舍正是这个 bug 的来源。
 * 对齐的坑用 koffi.sizeof 正面解决：x64 下 INPUT 必须 40 字节，`INPUT_SIZE` 导出去给自测断言
 * （尺寸错了 SendInput 只会返回 0，属于「静默不生效」，必须有断言钉住）。
 */
const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'int32',
  dy: 'int32',
  mouseData: 'uint32',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr_t',
});
const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16',
  wScan: 'uint16',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr_t',
});
const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', {
  uMsg: 'uint32',
  wParamL: 'uint16',
  wParamH: 'uint16',
});
const INPUT_UNION = koffi.union('INPUT_UNION', {
  mi: MOUSEINPUT,
  ki: KEYBDINPUT,
  hi: HARDWAREINPUT,
});
const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUT_UNION });

/** x64 下必须是 40。导出给自测断言 —— 错了会静默不生效，不能只靠肉眼。 */
export const INPUT_SIZE = koffi.sizeof(INPUT);

const INPUT_KEYBOARD = 1;

let api = null;
/** 惰性建一次动态库句柄与函数声明。 */
function lib() {
  if (api) return api;
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  api = {
    // HWND 一律用 uintptr_t。实测 koffi 3.2.1 下 uintptr_t 返回 **number**，可直接 !== 比较；
    // 不能用 `void*`（返回的是指针值，不可比数值）。
    GetForegroundWindow: user32.func('uintptr_t GetForegroundWindow()'),
    IsWindow: user32.func('bool IsWindow(uintptr_t hWnd)'),
    IsIconic: user32.func('bool IsIconic(uintptr_t hWnd)'),
    ShowWindow: user32.func('bool ShowWindow(uintptr_t hWnd, int nCmdShow)'),
    SetForegroundWindow: user32.func('bool SetForegroundWindow(uintptr_t hWnd)'),
    GetWindowThreadProcessId: user32.func(
      'uint32 GetWindowThreadProcessId(uintptr_t hWnd, _Out_ uint32* lpdwProcessId)'
    ),
    // 只读地查某个**线程**的焦点窗口。用它而不是 AttachThreadInput + GetFocus：
    // 后者会合并两个线程的输入队列，而它本身就是绕过前台锁的标准手法 ——
    // 拿它在旁边探测会改变被测行为（观测者效应），读到的结论不可信。
    GetGUIThreadInfo: user32.func('bool GetGUIThreadInfo(uint32 tid, _Inout_ GUITHREADINFO* info)'),
    GetClassNameW: user32.func('int GetClassNameW(uintptr_t hWnd, void* buf, int max)'),
    GetWindowTextW: user32.func('int GetWindowTextW(uintptr_t hWnd, void* buf, int max)'),
    GetCurrentThreadId: kernel32.func('uint32 GetCurrentThreadId()'),
    AttachThreadInput: user32.func(
      'bool AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)'
    ),
    // 一次调用投递整批按键。**不要**改回多次 keybd_event —— 那样 modifier 会丢，
    // 详见上面 INPUT 结构处的说明。
    SendInput: user32.func('uint32 SendInput(uint32 cInputs, INPUT* pInputs, int cbSize)'),
  };
  return api;
}

/** 取当前前台窗口。拿不到返回 null。 */
export function captureTarget() {
  const hwnd = lib().GetForegroundWindow();
  // 0 表示没有前台窗口（例如焦点在桌面上）。当作「没捕获到」，采纳时走回退路径。
  if (!hwnd) return null;
  return { kind: 'win', hwnd };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读当前前台句柄；拿不到返回 null。 */
function readForeground() {
  const hwnd = lib().GetForegroundWindow();
  return hwnd ? hwnd : null;
}

/**
 * 只读地取某个线程此刻的焦点窗口（不改变任何输入状态）。
 *
 * 用 GetGUIThreadInfo 而不是 AttachThreadInput + GetFocus：后者会把两个线程的输入
 * 队列合并，而 AttachThreadInput 本身就是绕过前台锁的标准手法 —— 拿它在旁边反复
 * 探测会改变被测行为，读到的结论不可信（这条是踩过坑的）。
 *
 * ⚠️ 纯粹诊断用，**不参与判定**：判定仍只看「回读前台窗口 == 目标」（spec §3）。
 * 之所以值得记下来，是因为「前台到了但焦点没到」正是真机上「报成功却什么都没插进去」
 * 的嫌疑机制 —— SendInput 投递的按键落到的是**焦点**窗口，不是前台窗口。
 */
function readFocusOfThread(tid) {
  if (!tid) return null;
  const info = {
    cbSize: GUITHREADINFO_SIZE,
    flags: 0,
    hwndActive: 0,
    hwndFocus: 0,
    hwndCapture: 0,
    hwndMenuOwner: 0,
    hwndMoveSize: 0,
    hwndCaret: 0,
    rcCaret: { left: 0, top: 0, right: 0, bottom: 0 },
  };
  return lib().GetGUIThreadInfo(tid, info) ? info : null;
}

/** 诊断用：读窗口的类名与标题，用来认出「捕获到的目标到底是谁」。内部用，不导出。 */
function describeWindow(hwnd) {
  if (!hwnd) return '(null)';
  const a = lib();
  const cls = Buffer.alloc(512);
  const title = Buffer.alloc(1024);
  a.GetClassNameW(hwnd, cls, 256);
  a.GetWindowTextW(hwnd, title, 512);
  const cut = (b) => b.toString('utf16le').replace(/\0.*$/, '');
  const c = cut(cls);
  const t = cut(title);
  // 标题为空时只回类名；非空时格式是 `类名 "标题"`（旧实现会多出一个游离的 `"`）。
  return t ? `${c} "${t}"` : c;
}

/**
 * 把一串按键作为**一个批次**投递（原子）。
 * keys = [[wVk, dwFlags], ...]
 */
function injectKeys(keys) {
  const a = lib();
  const events = keys.map(([wVk, dwFlags]) => ({
    type: INPUT_KEYBOARD,
    u: { ki: { wVk, wScan: 0, dwFlags, time: 0, dwExtraInfo: 0 } },
  }));
  const sent = a.SendInput(events.length, events, INPUT_SIZE);
  if (sent !== events.length) {
    // SendInput 会校验 cbSize：尺寸错就返回 0。**不能静默** —— 静默正是这个 bug 之前的形态。
    console.warn(
      `[注入] ⚠️ SendInput 只投递了 ${sent}/${events.length} 个事件（INPUT_SIZE=${INPUT_SIZE}，应为 40）`
    );
  }
}

/**
 * Ctrl + 某个键：修饰键先按下、目标键按下抬起、修饰键最后抬起。
 * 这一串**必须整批投递**，否则修饰键会丢（见 INPUT 结构处的说明）。
 */
const ctrlChord = (vk) => [
  [VK_CONTROL, 0],
  [vk, 0],
  [vk, KEYEVENTF_KEYUP],
  [VK_CONTROL, KEYEVENTF_KEYUP],
];

/**
 * 发一次 Ctrl+V。**由 index.js 在确认目标窗口已到前台之后调用**（见 Step 2）。
 *
 * 单独成一个原语、而不是塞进 activate() 里：发键必须发生在「回读确认目标确实到了
 * 前台」**之后**。若在确认之前发，置前失败时这串按键会落到当时的前台窗口上 ——
 * 用户的文本就被粘进了一个无关的应用。
 */
export function sendPaste() {
  const a = lib();
  // 发键这一刻的边界读数：前台是谁、**焦点**在谁手里。这是整条链最关键的一行 ——
  // 若焦点不在目标上，这串按键就会被别的窗口吃掉，而调用方仍会判定成功。
  if (DEBUG) {
    const fg = readForeground();
    const foc = readFocusOfThread(a.GetWindowThreadProcessId(fg, null))?.hwndFocus ?? null;
    dbg(
      `发键时: 前台=${fg} 该线程焦点窗口=${foc ?? 'null'}` +
        (foc ? ` = ${describeWindow(foc)}` : '（无焦点窗口：按键会走该线程的活动窗口）')
    );
  }
  // 诊断：只发一个字面字符。若它在目标里都不出现，说明目标**根本没收到**我们注入的
  // 按键（而不是"收到了但粘贴没发生"）—— 这两条的修法完全不同。
  if (PROBE === 'type') {
    dbg('探针模式 type：只发一个 z');
    injectKeys([
      [VK_Z, 0],
      [VK_Z, KEYEVENTF_KEYUP],
    ]);
    return;
  }
  // 诊断：Ctrl+A。在 Word / 浏览器 / 终端里都有可见效果，且不破坏内容。
  if (PROBE === 'selectall') {
    dbg('探针模式 selectall：发 Ctrl+A');
    injectKeys(ctrlChord(VK_A));
    return;
  }
  injectKeys(ctrlChord(VK_V));
}

/**
 * 把前台切到目标窗口，并回读一次实际的前台句柄。
 * **只切前台，不发键** —— 发键由 index.js 在判定通过后调 sendPaste()（见 Step 2）。
 *
 * 这里**不自己判定成功**，只回读句柄交给 index.js 用 classifyForeground 判 ——
 * 判定逻辑做成纯函数才有自测（真实的置前没法自动验，spec §6）。
 * 成功判据是「目标窗口确实到了前台」，不是「粘贴被消费了」—— 后者不可检（spec §3）。
 */
export async function activate(target) {
  // 平台实现自己守 kind：index.js 只按平台分派，不做形状校验（它不该认识 Target 的细节）。
  // 少了这一行，Windows 上拿到 mac 形状的目标会去解构不存在的 hwnd。
  if (target?.kind !== 'win') return { ok: false, reason: 'no-target' };

  const a = lib();
  const hwnd = target.hwnd;

  // 窗口可能在说话过程中被关掉了。
  if (!a.IsWindow(hwnd)) return { ok: false, reason: 'stale' };

  // 最小化的窗口直接置前不会自己还原，得先 SW_RESTORE。
  if (a.IsIconic(hwnd)) a.ShowWindow(hwnd, SW_RESTORE);

  if (!a.SetForegroundWindow(hwnd)) {
    // 前台锁：Windows 只允许满足条件的进程抢前台。AttachThreadInput 把当前线程挂到
    // 目标窗口所属线程上，让两者共享输入状态，从而绕过这条限制。这是标准的兜底手法。
    const tid = a.GetWindowThreadProcessId(hwnd, null);
    const cur = a.GetCurrentThreadId();
    a.AttachThreadInput(cur, tid, true);
    try {
      a.SetForegroundWindow(hwnd);
    } finally {
      // 必须卸掉：挂着会让两个线程的输入状态一直耦合，是实打实的副作用。
      a.AttachThreadInput(cur, tid, false);
    }
  }

  // 等待 + 诊断探测。**不改变判定**：仍然等满 waitMs，返回的仍是回读到的前台句柄。
  // 探测要回答的是「前台什么时候到」「目标线程什么时候真的拿到键盘焦点」——
  // SendInput 投递的按键落到**焦点**窗口，二者不同步就是「报成功却没插进去」的机制。
  const targetTid = a.GetWindowThreadProcessId(hwnd, null);
  const t0 = Date.now();
  const wait = waitMs();
  let fgAt = null;
  let focusAt = null;
  let lastFocus = null;

  if (DEBUG) {
    dbg(`目标窗口 ${hwnd} = ${describeWindow(hwnd)}`);
    // 注意：这是 SetForegroundWindow **之后**的读数。激活是异步的，此刻前台常为
    // null（窗口正在交接），13ms 量级后才稳定 —— 不要把它当异常。
    dbg(`置前后: 前台=${readForeground()} 目标线程=${targetTid}`);
  }

  for (;;) {
    const el = Date.now() - t0;
    if (fgAt === null && readForeground() === hwnd) fgAt = el;
    lastFocus = readFocusOfThread(targetTid)?.hwndFocus ?? null;
    if (focusAt === null && lastFocus && a.GetWindowThreadProcessId(lastFocus, null) === targetTid) {
      focusAt = el;
    }
    if (el >= wait) break;
    await sleep(PROBE_INTERVAL_MS);
  }

  const fg = readForeground();
  if (DEBUG) {
    dbg(
      `前台到位=${fgAt ?? '未到'}ms 焦点到位=${focusAt ?? '未到'}ms 等满=${wait}ms` +
        ` | 结束时前台=${fg}(${fg === hwnd ? '==目标' : '≠目标'}) 目标线程焦点窗口=${lastFocus ?? 'null'}`
    );
    if (lastFocus) dbg(`焦点窗口 ${lastFocus} = ${describeWindow(lastFocus)}`);
  }
  // ⚠️ 只在 DEBUG 下报，而且**不声称粘贴一定会失败**。
  // 真机上见过这条打出来、粘贴却成功了（该线程没有焦点窗口时，注入的按键仍会被路由到
  // 它的活动窗口）。所以它是诊断观察、不是失败信号 —— 无条件当作产品告警打，只会把
  // 「成功」教成「忽略告警」。本文件其余诊断同样一律 DEBUG 门控。
  if (DEBUG && focusAt === null) {
    console.warn(
      `[注入] 观测：目标窗口已到前台，但目标线程在 ${wait}ms 内没有读到自己的键盘焦点窗口。` +
        `这不一定代表粘贴会失败（注入的按键仍可能被路由到该线程的活动窗口），仅供排障参考。`
    );
  }
  return { ok: true, id: fg };
}
