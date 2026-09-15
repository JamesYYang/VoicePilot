import { clipboard } from 'electron';
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
  const result = await decidePaste(platform, target);
  // 唯一出口处统一打一行：真机排障时「到底走到哪个分支」是最先要看的东西。
  // 顺带报一下剪贴板长度 —— 它是整条链的前提，而「粘贴没发生」极容易是
  // 「发键那一刻剪贴板其实是空的」伪装成的。
  if (process.env.VP_INJECT_DEBUG === '1') {
    let clipLen = '?';
    try {
      clipLen = (await clipboard.readText()).length;
    } catch {
      /* 读剪贴板失败不影响主流程 */
    }
    console.log(
      `[注入] 编排结果: ${result.ok ? 'ok' : `失败 reason=${result.reason}`} | 发键后剪贴板长度=${clipLen}`
    );
  }
  return result;
}

/**
 * 激活步骤：置前 → 回读确认。**故意不接住异常**。
 *
 * 两个调用方对「activate 抛异常」的归因不同，且各自都有断言钉着：
 *   - 粘贴路径（decidePaste）：抛异常 → `send-failed`（既有断言，见 selftest/inject.js:149）；
 *   - 只置前路径（activateWith）：抛异常 → `activate-failed`（它根本没有发键这一步）。
 * 统一在这里吞掉会把前者改坏。
 */
async function activateStep(platform, target) {
  if (!platform || !target) return { ok: false, reason: 'no-target' };

  const a = await platform.activate(target);
  if (!a?.ok) return { ok: false, reason: a?.reason ?? 'activate-failed' };

  // 平台实现回读到的前台标识。Windows 是 HWND(number)，macOS 是 pid(number)。
  return classifyForeground(target.hwnd ?? target.pid, a.id);
}

/**
 * 实际编排。抽成独立函数只是为了让 pasteWith 有**唯一出口**，好在那一处统一打诊断；
 * 逻辑与判定完全在内，未做任何改动。
 */
async function decidePaste(platform, target) {
  try {
    // 顺序是安全属性：确认为止一次键都不能发（见 spec 2026-09-13 §3）。
    const act = await activateStep(platform, target);
    if (!act.ok) return act;

    platform.sendPaste(target);
    return { ok: true };
  } catch (e) {
    console.warn(`[注入] 粘贴失败：${e?.message ?? e}`);
    return { ok: false, reason: 'send-failed' };
  }
}

/**
 * 只置前、不发任何按键。用于「关掉常用语选择器后把焦点还给用户原来的应用」。
 * 与 pasteTo 共用 activateStep，避免两份激活与确认逻辑漂移。
 *
 * 失败一律不抛、只回 reason：调用方（状态机）在关闭路径上不该因为归还焦点失败
 * 而中断收尾 —— 失败只写日志（spec §6 第 6 条）。
 */
export async function activateWith(platform, target) {
  try {
    return await activateStep(platform, target);
  } catch (e) {
    console.warn(`[注入] 置前失败：${e?.message ?? e}`);
    return { ok: false, reason: 'activate-failed' };
  }
}

/** 把 target 置前。调用方负责不要在这之后发键 —— 本函数只做前置。 */
export function activateTarget(target) {
  return activateWith(impl, target);
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
