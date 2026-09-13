import { globalShortcut } from 'electron';
import { applyShortcut, boundShortcut, defaultAccel, defaultPhraseAccel, setShortcutSuspended } from '../shortcut.js';

/**
 * 全局快捷键注册的回归自测。
 *
 * 用真实的 globalShortcut（headless Electron 进程能注册，已实测），
 * 只借四个冷门组合键 Control+Alt+Shift+F9/F10/F11/F12，跑完立刻 unregisterAll。
 */
export async function runShortcutSelftest() {
  console.log('[自测] 全局快捷键（shortcut）');

  const A = 'Control+Alt+Shift+F9';
  const B = 'Control+Alt+Shift+F10';
  const C = 'Control+Alt+Shift+F11';
  const fakeMachine = { toggle() {}, openPhrases() {} };

  // 纯函数默认值：Windows 不能用 Alt+Space（系统菜单）/ Win+Space（输入法切换）
  const okDefault = defaultAccel('darwin') === 'Alt+Space' && defaultAccel('win32') === 'Ctrl+Shift+Space';

  // ---- 1. 首次注册：成功且真的注册上了 ----
  const okFirst = applyShortcut(fakeMachine, A) === true && globalShortcut.isRegistered(A) === true;

  // ---- 2. 重录当前键：重复注册必然返回 false，但应视为成功（避免误报冲突）----
  const okRerecord = applyShortcut(fakeMachine, A) === true && boundShortcut() === A;

  // ---- 3. 换键：新键生效、旧键被注销 ----
  const okReplace =
    applyShortcut(fakeMachine, B) === true &&
    globalShortcut.isRegistered(B) === true &&
    globalShortcut.isRegistered(A) === false;

  // ---- 4. 回归：挂起态下改键 ----
  // 设置页录制时主进程处于 setSuspended(true)，此时 register 必然返回 false。
  // applyShortcut 必须先恢复挂起态再注册，否则每次改键都会误报「已被其他程序占用」。
  setShortcutSuspended(true);
  const okSuspendedApply = applyShortcut(fakeMachine, C) === true;
  const okSuspendedRegistered = globalShortcut.isRegistered(C) === true;
  // 挂起态必须已被 applyShortcut 解除：A 在用例 3 里随 B 的注册被注销，此刻空闲，
  // 若管理器仍处于挂起态，这次 register 会失败 → 用例变红。
  const okResumedAfter = applyShortcut(fakeMachine, A) === true && globalShortcut.isRegistered(A) === true;

  // ---- 5. 非法 accelerator：注册失败但不得毁掉已生效的键 ----
  // register 对 'Ctrl+ ' 会抛异常（而非返回 false），applyShortcut 必须接住，
  // 且因为「先注册后注销」，旧键 A 从未被注销 —— 仍然生效。
  let okMalformed = false;
  try {
    okMalformed = applyShortcut(fakeMachine, 'Ctrl+ ') === false;
  } catch {
    okMalformed = false; // 异常逃出 applyShortcut 即失败
  }
  const okMalformedKeepsBinding =
    globalShortcut.isRegistered(A) === true && boundShortcut() === A;

  // ---- 6. 挂起态下重录当前键：prev === accel 短路必须返回 true ----
  // 挂起态里 register 必然返回 false（见用例 4），而「重录当前键」本身也是
  // 重复注册、register 同样返回 false。两者叠加时若只看 register 的返回值，
  // 用户点一次「把当前键设为生效键」就会被误报成「已被占用」。
  setShortcutSuspended(true);
  const okSuspendedRerecord = applyShortcut(fakeMachine, A) === true && boundShortcut() === A;

  // ---- 7. 常用语槽位：与主槽位互不干扰 ----
  const okPhraseDefault =
    defaultPhraseAccel('win32') === 'Ctrl+Alt+Space' &&
    defaultPhraseAccel('darwin') === 'Alt+Shift+Space';

  const A2 = 'Control+Alt+Shift+F12';
  // 防御：别让本用例的成败依赖前面几个用例的注册/注销序列。
  globalShortcut.unregister(C);
  const okPhraseFirst =
    applyShortcut(fakeMachine, A2, 'phrases') === true &&
    globalShortcut.isRegistered(A2) === true &&
    boundShortcut('phrases') === A2;
  // 主槽位此刻绑的是 A（用例 6 之后），注册短语键不得把它顶掉
  const okMainKept = boundShortcut('main') === A && globalShortcut.isRegistered(A) === true;

  // 短语槽位换键：旧的短语键被注销，主键仍不受影响
  const okPhraseReplace =
    applyShortcut(fakeMachine, C, 'phrases') === true &&
    globalShortcut.isRegistered(C) === true &&
    globalShortcut.isRegistered(A2) === false &&
    globalShortcut.isRegistered(A) === true;

  // 短语槽位撞主槽位：register 返回 false → 视为失败，且**不得**改绑定、不得注销主键
  const okPhraseConflict =
    applyShortcut(fakeMachine, A, 'phrases') === false &&
    boundShortcut('phrases') === C &&
    globalShortcut.isRegistered(A) === true;

  globalShortcut.unregisterAll();

  const ok =
    okDefault && okFirst && okRerecord && okReplace &&
    okSuspendedApply && okSuspendedRegistered && okResumedAfter &&
    okMalformed && okMalformedKeepsBinding && okSuspendedRerecord &&
    okPhraseDefault && okPhraseFirst && okMainKept && okPhraseReplace && okPhraseConflict;
  console.log(
    `[自测] ${ok ? '通过' : '失败'} 默认值=${okDefault} 首次=${okFirst} 重录=${okRerecord} 换键=${okReplace} ` +
    `挂起注册=${okSuspendedApply} 挂起后已注册=${okSuspendedRegistered} 恢复=${okResumedAfter} ` +
    `非法键=${okMalformed} 非法键不毁旧键=${okMalformedKeepsBinding} 挂起重录=${okSuspendedRerecord} ` +
    `短语默认=${okPhraseDefault} 短语首次=${okPhraseFirst} 主键保持=${okMainKept} ` +
    `短语换键=${okPhraseReplace} 短语冲突=${okPhraseConflict}`
  );
  return { ok };
}
