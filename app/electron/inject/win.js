import koffi from 'koffi';

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
// 诊断用：换掉「要发什么键」，用来区分失败发生在哪一段。
//   type      —— 只发一个字面字符 z：若它进不去，说明按键**根本没被目标收到**
//   selectall —— 发 Ctrl+A：在 Word/浏览器/终端里都有可见效果且不破坏内容
//   scancode  —— 仍发 Ctrl+V，但把 bScan 填成真实扫描码（MapVirtualKey）
// 不设 = 现状（Ctrl+V，bScan=0）。
const PROBE = process.env.VP_INJECT_PROBE ?? '';
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
    // 用 keybd_event 而不是 SendInput：本场景只要一次四键组合，用不上 SendInput 的
    // 批量能力；而 SendInput 要声明 INPUT 联合体，x64 下有 4 字节对齐填充（应为 40
    // 字节），写错了不报错、只是静默不生效。keybd_event 已废弃但仍在 user32 里工作，
    // 签名只有四个标量参数。
    keybd_event: user32.func('void keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr_t dwExtraInfo)'),
    MapVirtualKeyW: user32.func('uint32 MapVirtualKeyW(uint32 uCode, uint32 uMapType)'),
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
 * 的嫌疑机制 —— keybd_event 的按键投给的是**焦点**窗口，不是前台窗口。
 */
function readFocusOfThread(tid) {
  if (!tid) return null;
  const info = {
    cbSize: koffi.sizeof(GUITHREADINFO),
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
  return `${cut(cls)}" ${cut(title) ? `"${cut(title)}"` : ''}`.trim();
}

/**
 * 发一次 Ctrl+V。**由 index.js 在确认目标窗口已到前台之后调用**（见 Step 2）。
 * keybd_event 返回 void，所以只能靠「有没有抛」判断失败。
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
        (foc ? ` = ${describeWindow(foc)}` : '（无焦点窗口：按键会被丢弃）')
    );
  }
  // 诊断：只发一个字面字符。若它在目标里都不出现，说明目标**根本没收到**我们注入的
  // 按键（而不是"收到了但粘贴没发生"）—— 这两条的修法完全不同。
  if (PROBE === 'type') {
    dbg('探针模式 type：只发一个 z');
    a.keybd_event(VK_Z, 0, 0, 0);
    a.keybd_event(VK_Z, 0, KEYEVENTF_KEYUP, 0);
    return;
  }
  // 诊断：Ctrl+A。在 Word / 浏览器 / 终端里都有可见效果，且不破坏内容。
  if (PROBE === 'selectall') {
    dbg('探针模式 selectall：发 Ctrl+A');
    a.keybd_event(VK_CONTROL, 0, 0, 0);
    a.keybd_event(VK_A, 0, 0, 0);
    a.keybd_event(VK_A, 0, KEYEVENTF_KEYUP, 0);
    a.keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
    return;
  }
  // bScan：现状一律传 0。部分应用（尤其 Chromium 系与 Office）会参考扫描码，
  // 传 0 可能被当成无效键丢弃 —— 这是待验证的候选根因之一，故做成可切换的探针。
  const scan = (vk) => (PROBE === 'scancode' ? a.MapVirtualKeyW(vk, 0) : 0);
  if (PROBE === 'scancode') dbg(`探针模式 scancode：Ctrl+V，扫描码 ctrl=${scan(VK_CONTROL)} v=${scan(VK_V)}`);
  a.keybd_event(VK_CONTROL, scan(VK_CONTROL), 0, 0);
  a.keybd_event(VK_V, scan(VK_V), 0, 0);
  a.keybd_event(VK_V, scan(VK_V), KEYEVENTF_KEYUP, 0);
  a.keybd_event(VK_CONTROL, scan(VK_CONTROL), KEYEVENTF_KEYUP, 0);
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
  // keybd_event 的按键投给**焦点**窗口，二者不同步就是「报成功却没插进去」的机制。
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
  if (focusAt === null) {
    console.warn(
      `[注入] ⚠️ 目标窗口拿到了前台，但目标线程在 ${wait}ms 内**没有拿到键盘焦点**：` +
        `此时发键会落到仍持有焦点的窗口里（很可能就是我们自己）→ 文本不会进入目标。`
    );
  }
  return { ok: true, id: fg };
}
