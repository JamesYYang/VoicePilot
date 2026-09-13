import { globalShortcut } from 'electron';
import { getShortcut, getPhraseShortcut } from './store.js';

/**
 * 全局快捷键的注册与生命周期。
 *
 * 抽成独立模块是为了能被主进程自测直接驱动：注册行为对「挂起态」与
 * 「非法 accelerator」两种输入的响应都不直观，必须有回归用例钉住。
 */

/** 平台默认快捷键。Windows 不能用 Alt+Space（系统菜单）或 Win+Space（输入法切换）。 */
export function defaultAccel(platform = process.platform) {
  return platform === 'darwin' ? 'Alt+Space' : 'Ctrl+Shift+Space';
}

/** 平台默认的常用语快捷键。避开主键、系统菜单键与输入法切换键。 */
export function defaultPhraseAccel(platform = process.platform) {
  return platform === 'darwin' ? 'Alt+Shift+Space' : 'Ctrl+Alt+Space';
}

const DEFAULT_FOR = (slot) => (slot === 'phrases' ? defaultPhraseAccel() : defaultAccel());

/** 当前生效的快捷键（用户自定义优先）。trim 是因为 store 存的是原值，可能带空白。 */
export function currentAccel(slot = 'main') {
  const stored = slot === 'phrases' ? getPhraseShortcut() : getShortcut();
  return (stored ?? DEFAULT_FOR(slot)).trim();
}

export function setShortcutSuspended(suspended) {
  globalShortcut.setSuspended(Boolean(suspended));
}

/** 已绑定的 accelerator，按槽位分开存。 */
const boundAccel = new Map();

/** 当前已绑定的 accelerator（测试与排查用）。slot 省略即主快捷键。 */
export function boundShortcut(slot = 'main') {
  return boundAccel.get(slot) ?? null;
}

/**
 * 注册新键、成功后才注销旧键。返回是否成功。**按槽位（main/phrases）各管一套**。
 * 失败（被别的程序占用，或 accelerator 非法）时不改 store ——
 * 保持「当前生效键」与「已存键」一致。
 *
 * 两条来自实测的硬约束：
 *  1. register 对非法 accelerator（如 'Ctrl+ '）会**抛异常**而不是返回 false，
 *     所以「先注销后注册」会让旧热键彻底失效 —— 必须先注册、成功后才注销。
 *  2. **挂起期间 register 必然返回 false**（实测：setSuspended(true) 后
 *     register('Control+Alt+Shift+F10') → false，且 isRegistered 也是 false）。
 *     录制快捷键时主进程处于挂起态，而渲染进程的重渲染时机不受我们控制，
 *     所以这里必须先恢复再注册，否则每一次改键都会误报「已被占用」。
 */
export function applyShortcut(machine, accel, slot = 'main') {
  const prev = boundAccel.get(slot) ?? null;

  // 见注释第 2 条：无论调用方处于什么状态，注册前先确保未挂起。
  setShortcutSuspended(false);

  const handler =
    slot === 'phrases'
      ? () => {
          void machine.openPhrases();
        }
      : () => {
          // 直接驱动状态机，不再经渲染进程转发（状态只有一个源头）
          void machine.toggle();
        };

  let ok = false;
  try {
    ok = globalShortcut.register(accel, handler);
  } catch (e) {
    // 非法 accelerator 走这里。当成注册失败处理，旧键未被注销，仍然生效。
    console.error(`[快捷键] ${accel} 注册异常：${e?.message ?? e}`);
    ok = false;
  }

  // 重录当前键：重复注册必然返回 false，但它本来就在生效 —— 视为成功，避免误报冲突。
  if (!ok && prev === accel) return true;

  if (ok) {
    if (prev && prev !== accel) globalShortcut.unregister(prev);
    boundAccel.set(slot, accel);
    console.log(`[快捷键] ${slot} ${accel} 已注册`);
  } else {
    console.error(`[快捷键] ${slot} ${accel} 注册失败：可能已被其他程序占用`);
    boundAccel.set(slot, prev); // 旧键从未被注销，仍指向它
  }
  return ok;
}
