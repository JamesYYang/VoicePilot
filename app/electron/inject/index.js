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
