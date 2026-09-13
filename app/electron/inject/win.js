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
const KEYEVENTF_KEYUP = 0x0002;
// 置前是异步的：SetForegroundWindow 返回时目标未必已经真的拿到前台。
// 60ms 是起点不是承诺（spec §8 第 7 条），真机不合就在 Task 8 调。
const ACTIVATE_WAIT_MS = 60;

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
    GetCurrentThreadId: kernel32.func('uint32 GetCurrentThreadId()'),
    AttachThreadInput: user32.func(
      'bool AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)'
    ),
    // 用 keybd_event 而不是 SendInput：本场景只要一次四键组合，用不上 SendInput 的
    // 批量能力；而 SendInput 要声明 INPUT 联合体，x64 下有 4 字节对齐填充（应为 40
    // 字节），写错了不报错、只是静默不生效。keybd_event 已废弃但仍在 user32 里工作，
    // 签名只有四个标量参数。
    keybd_event: user32.func('void keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr_t dwExtraInfo)'),
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

/** 发一次 Ctrl+V。keybd_event 返回 void，所以只能靠「有没有抛」判断失败。 */
function sendCtrlV() {
  const a = lib();
  a.keybd_event(VK_CONTROL, 0, 0, 0);
  a.keybd_event(VK_V, 0, 0, 0);
  a.keybd_event(VK_V, 0, KEYEVENTF_KEYUP, 0);
  a.keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
}

/**
 * 把前台切到目标窗口。**调用方必须已经写好剪贴板**。
 *
 * 这里**不自己判定成功**，只回读一次前台句柄交给 index.js 用 classifyForeground 判 ——
 * 判定逻辑做成纯函数才有自测（真实的置前没法自动验，spec §6）。
 * 成功判据是「目标窗口确实到了前台」，不是「粘贴被消费了」—— 后者不可检（spec §3）。
 */
export async function pasteTo(target) {
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

  await sleep(ACTIVATE_WAIT_MS);
  sendCtrlV();
  return { ok: true, id: readForeground() };
}
