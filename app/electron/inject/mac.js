import koffi from 'koffi';

/**
 * macOS 注入实现。
 *
 * ⚠️ 顶层绝不 koffi.load()：index.js 静态 import 了本文件。
 *
 * 为什么用 objc_msgSend 而不是 osascript：osascript 需要**两个** TCC 权限
 * （辅助功能 + 自动化/Apple Events），而 CGEventPost 只要辅助功能一项，
 * 正好接上已有的 vp:permission/status 与 F12 引导。见 spec §4.2。
 */

const BOTH_ACTIVATION_OPTIONS = 3; // NSApplicationActivateAllWindows(1) | IgnoringOtherApps(2)
const VK_V = 0x09;
const K_CG_EVENT_FLAG_MASK_COMMAND = 1 << 20;
const K_CG_HID_EVENT_TAP = 0;
const ACTIVATE_WAIT_MS = 120; // 比 Windows 长：macOS 的应用激活与窗口提升是异步的

let api = null;

function lib() {
  if (api) return api;

  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const objc_getClass = objc.func('void* objc_getClass(const char* name)');
  const sel_registerName = objc.func('void* sel_registerName(const char* name)');

  // objc_msgSend 是**变参**函数，返回类型随被调方法而变。必须按签名分别声明，
  // 用错声明不会报错、只会静默拿到垃圾值 —— 这是本文件最需要真机验的地方。
  const msgSendPtr = objc.func('void* objc_msgSend(void* receiver, void* selector)');
  const msgSendI32 = objc.func('int32_t objc_msgSend(void* receiver, void* selector)');
  const msgSendCStr = objc.func('const char* objc_msgSend(void* receiver, void* selector)');
  const msgSendPtrI32 = objc.func('void* objc_msgSend(void* receiver, void* selector, int32_t arg)');
  // activateWithOptions: 的参数是 NSUInteger（64 位）。**必须声明成 64 位**：声明成
  // uint32_t 时 koffi 只写寄存器的低 32 位，高 32 位是什么由 ABI 决定，目标可能读到一个
  // 天文数字的 options。传 number 即可（Task 1 实测 uintptr_t 与 number 互通）。
  //
  // 返回类型是 **BOOL**（方法签名 `- (BOOL)activateWithOptions:`），不是 void。
  // 但**不要使用这个返回值**：macOS 14 起该位（IgnoringOtherApps）已被弃用，公开资料
  // 常见「返回 YES 却没真的置前」（本机未验）。本设计的成功判据是**回读前台窗口**
  // 那一条（spec §3），多一个会骗人的判据只会引入误报。声明成 bool 只是为了让声明与 API 一致。
  const msgSendBoolUPtr = objc.func('bool objc_msgSend(void* receiver, void* selector, uintptr_t arg)');

  // 只为确保 AppKit 已在本进程里加载，否则 objc_getClass('NSWorkspace') 会拿到 null。
  // Electron 是 Cocoa 应用、AppKit 本来就在，这一行是把这层隐含依赖写明白。
  koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');

  // CGEvent* 与 CFRelease 来自**不同的**框架，必须各自 load：koffi 的 func() 是在
  // 被 load 的那个库里取符号，靠「AppKit 依赖 CoreGraphics」蹭到符号是侥幸不是契约。
  const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
  const CGEventCreateKeyboardEvent = cg.func(
    'void* CGEventCreateKeyboardEvent(void* source, uint16_t virtualKey, bool keyDown)'
  );
  const CGEventSetFlags = cg.func('void CGEventSetFlags(void* event, uint64_t flags)');
  const CGEventPost = cg.func('void CGEventPost(uint32_t tap, void* event)');
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const CFRelease = cf.func('void CFRelease(void* cf)');

  const appsvc = koffi.load(
    '/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices'
  );
  const AXIsProcessTrusted = appsvc.func('bool AXIsProcessTrusted()');

  api = {
    objc_getClass,
    sel_registerName,
    msgSendPtr,
    msgSendI32,
    msgSendCStr,
    msgSendPtrI32,
    msgSendBoolUPtr,
    CGEventCreateKeyboardEvent,
    CGEventSetFlags,
    CGEventPost,
    CFRelease,
    AXIsProcessTrusted,
    NSWorkspace: objc_getClass('NSWorkspace'),
    NSRunningApplication: objc_getClass('NSRunningApplication'),
    sel_sharedWorkspace: sel_registerName('sharedWorkspace'),
    sel_frontmostApplication: sel_registerName('frontmostApplication'),
    sel_processIdentifier: sel_registerName('processIdentifier'),
    sel_bundleIdentifier: sel_registerName('bundleIdentifier'),
    sel_UTF8String: sel_registerName('UTF8String'),
    sel_runningAppWithPid: sel_registerName('runningApplicationWithProcessIdentifier:'),
    sel_activateWithOptions: sel_registerName('activateWithOptions:'),
  };
  return api;
}

/** 当前前台应用的 pid；拿不到返回 null。 */
function frontPid() {
  const a = lib();
  const front = a.msgSendPtr(a.NSWorkspace, a.sel_sharedWorkspace);
  if (!front) return null;
  const app = a.msgSendPtr(front, a.sel_frontmostApplication);
  if (!app) return null;
  const pid = Number(a.msgSendI32(app, a.sel_processIdentifier));
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/**
 * 前台应用的 bundle id，只为日志与排障。**必须包 try/catch 并允许返回 null**：
 * 这要连跳两次 objc_msgSend（bundleIdentifier → UTF8String），是本文件里最容易
 * 拿到野指针的一处。它失败不该影响注入本身，所以绝不参与成功判据。
 */
function frontBundleId() {
  try {
    const a = lib();
    const front = a.msgSendPtr(a.NSWorkspace, a.sel_sharedWorkspace);
    const app = a.msgSendPtr(front, a.sel_frontmostApplication);
    const nsstr = a.msgSendPtr(app, a.sel_bundleIdentifier);
    if (!nsstr) return null;
    const s = a.msgSendCStr(nsstr, a.sel_UTF8String);
    return typeof s === 'string' && s.length > 0 ? s : null;
  } catch {
    return null;
  }
}

export function captureTarget() {
  const pid = frontPid();
  if (pid == null) return null;
  // 不能捕获到我们自己：命中说明调用时机错了（悬浮条已经在前台），
  // 拿它当目标会变成「把文本粘回自己」。
  if (pid === process.pid) return null;
  return { kind: 'mac', pid, bundleId: frontBundleId() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 发一次 Cmd+V。**由 index.js 在确认目标应用已到前台之后调用**（与 Windows 同形）。
 * 事件创建出来必须 CFRelease，否则每采纳一次泄漏一个事件。
 */
export function sendPaste() {
  const a = lib();
  for (const keyDown of [true, false]) {
    const ev = a.CGEventCreateKeyboardEvent(null, VK_V, keyDown);
    if (!ev) continue;
    a.CGEventSetFlags(ev, K_CG_EVENT_FLAG_MASK_COMMAND);
    a.CGEventPost(K_CG_HID_EVENT_TAP, ev);
    a.CFRelease(ev);
  }
}

/**
 * 把目标应用切到前台并回读一次实际的前台 pid。**只切前台，不发键** ——
 * 发键由 index.js 在判定通过后调 sendPaste()。
 *
 * 单独成原语的理由与 Windows 侧相同：若在确认之前发键，激活失败时 Cmd+V 会落到
 * 当时的前台应用上，用户的文本就被粘进了无关的窗口。
 */
export async function activate(target) {
  // 平台实现自己守 kind：index.js 只按平台分派，不做形状校验（它不该认识 Target 的细节）。
  if (target?.kind !== 'mac') return { ok: false, reason: 'no-target' };

  const a = lib();

  // 权限前置：没有辅助功能权限时 CGEventPost 会被静默丢弃，与其发一次白功，
  // 不如直接给出可操作的 reason，让界面引导用户去 F12。
  if (!a.AXIsProcessTrusted()) return { ok: false, reason: 'permission' };

  // runningApplicationWithProcessIdentifier: 返回 nil 说明那个进程已经不在了。
  const app = a.msgSendPtrI32(a.NSRunningApplication, a.sel_runningAppWithPid, target.pid);
  if (!app) return { ok: false, reason: 'stale' };

  // 返回值故意丢弃：见 lib() 里 msgSendBoolUPtr 的注释（macOS 14+ 上它会骗人）。
  a.msgSendBoolUPtr(app, a.sel_activateWithOptions, BOTH_ACTIVATION_OPTIONS);

  await sleep(ACTIVATE_WAIT_MS);
  return { ok: true, id: frontPid() };
}
