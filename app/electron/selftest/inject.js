import koffi from 'koffi';

/**
 * 注入层自测。
 *
 * 这里**只验「koffi 能在这个平台上加载并调用」**（spec §8 第 1 条，实施第一步的
 * 关卡）。真实的置前与粘贴没法在无人值守的进程里验，只能真机手工过（spec §6）。
 */
export async function runInjectSelftest() {
  console.log('[自测] 注入层（inject）');
  const results = [];
  const check = (name, cond, detail = '') => {
    results.push({ name, ok: Boolean(cond), detail });
    console.log(`${cond ? ' ok ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  };

  check('koffi 已加载且暴露 load()', typeof koffi?.load === 'function');

  if (process.platform === 'win32') {
    // 这一步同时在验「打包后 .node 能被 dlopen」（spec §8 第 1/2/3 条）。
    const user32 = koffi.load('user32.dll');
    const GetForegroundWindow = user32.func('uintptr_t GetForegroundWindow()');
    const hwnd = GetForegroundWindow();
    // 无人值守进程里可能没有前台窗口（返回 0），所以不断言具体值，只断言**类型对**。
    // 这里的核心契约是「返回可比数值，而不是每次新建的指针对象」——只有前者能用 !== 判等。
    //
    // 实测偏差（koffi 3.2.1 / Electron 44 / win32-x64）：uintptr_t 解出来是 **number**，
    // 不是 brief 预期的 bigint。同口径实测：uintptr_t / uint64_t / intptr_t → number，
    // void* → bigint，koffi.address(x) 一律归一成 bigint。故按实测放宽到 number|bigint，
    // 而不是改口说它是 bigint（结论已回写报告，供 Task 3/4 使用）。
    check(
      'GetForegroundWindow() 返回可比数值（uintptr_t → number，非指针对象）',
      typeof hwnd === 'number' || typeof hwnd === 'bigint',
      `${typeof hwnd} ${hwnd}`
    );
  } else if (process.platform === 'darwin') {
    const cg = koffi.load(
      '/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics'
    );
    // 创建事件不需要辅助功能权限（Post 才需要），所以这一步在未授权时也应通过。
    const CGEventCreateKeyboardEvent = cg.func(
      'void* CGEventCreateKeyboardEvent(void* source, uint16_t virtualKey, bool keyDown)'
    );
    const ev = CGEventCreateKeyboardEvent(null, 0x09, true);
    check('CGEventCreateKeyboardEvent 可调用并返回事件', ev != null, String(ev));
  } else {
    check('不支持的平台：跳过平台库加载', true, process.platform);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  for (const f of failed) console.log(`  FAIL ${f.name} ${f.detail}`);
  return { ok: failed.length === 0, failed: failed.length, total: results.length };
}
