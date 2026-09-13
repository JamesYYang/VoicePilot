import * as win from './win.js';
import * as mac from './mac.js';

/**
 * 平台注入适配层的唯一入口。业务只跟这里打交道。
 *
 * ⚠️ 这里对两个平台实现做**静态 import**，不做惰性 import()。理由是 captureTarget()
 * 必须同步：惰性 import() 是异步的，会把捕获推到下一次微任务，而捕获必须发生在
 * 状态机进 warming 之前。可以静态 import 的前提是**两个平台模块顶层都不碰动态库**
 * （只在函数内 koffi.load()）—— 否则 macOS 上 win.js 的 load('user32.dll') 会在
 * 应用启动那一刻就抛。
 */
const impl = process.platform === 'win32' ? win : process.platform === 'darwin' ? mac : null;

/**
 * 纯函数：据「目标标识」与「置前完成后回读到的前台标识」判定结果。
 * 抽成纯函数是为了它有自测 —— 真实的置前没法自动验（spec §6）。
 */
export function classifyForeground(targetId, actualId) {
  if (targetId == null) return { ok: false, reason: 'no-target' };
  if (actualId != null && targetId === actualId) return { ok: true };
  return { ok: false, reason: 'activate-failed' };
}

/**
 * 快捷键触发那一刻取一次前台窗口。失败一律返回 null 而不抛 ——
 * 捕获失败不该让听写本身失败（用户还能手动粘）。
 */
export function captureTarget() {
  if (!impl) return null;
  try {
    return impl.captureTarget();
  } catch (e) {
    console.warn(`[注入] 捕获前台窗口失败：${e?.message ?? e}`);
    return null;
  }
}

/**
 * 编排：切前台 → 回读确认 → **只有确认通过才发键**。
 *
 * 写成「接 platform 参数」而不是直接吃模块级的 impl，是为了能被自测驱动：这条顺序
 * 约束是**安全属性**而非风格 —— 发早了，那串按键会落到当时的前台窗口上，用户的文本
 * 就被粘进了无关的应用。真机验一次不能防回归，必须是可自动跑的断言。
 */
export async function pasteWith(platform, target) {
  if (!platform || !target) return { ok: false, reason: 'no-target' };
  try {
    const a = await platform.activate(target);
    if (!a?.ok) return { ok: false, reason: a?.reason ?? 'activate-failed' };

    // 平台实现回读到的前台标识。Windows 是 HWND(number)，macOS 是 pid(number)。
    const cls = classifyForeground(target.hwnd ?? target.pid, a.id);
    if (!cls.ok) return cls;

    platform.sendPaste();
    return { ok: true };
  } catch (e) {
    console.warn(`[注入] 粘贴失败：${e?.message ?? e}`);
    return { ok: false, reason: 'send-failed' };
  }
}

/**
 * 把剪贴板内容粘贴到 target。**调用方必须先写好剪贴板**（渲染进程经 vp:copy）。
 *
 * 成功判据 = 「目标窗口确实到了前台」。这不是「粘贴被消费了」的判据 ——
 * 后者原理上不可检（发键 API 只报告事件入队，不报告目标应用是否处理）。
 * 管理员权限窗口（Windows UIPI）会因此静默失败，这是 spec §0 已接受的代价。
 */
export function pasteTo(target) {
  return pasteWith(impl, target);
}
