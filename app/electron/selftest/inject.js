import koffi from 'koffi';
import { captureTarget, classifyForeground, pasteTo, pasteWith } from '../inject/index.js';

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

  // ---- 纯函数：置前判定（真实的置前没法自动验，这里是唯一的自动护栏）----
  check('目标为 null → no-target',
    classifyForeground(null, 123)?.reason === 'no-target');
  check('回读到的前台与目标一致 → ok',
    classifyForeground(123, 123)?.ok === true);
  check('回读到的前台与目标不一致 → activate-failed',
    classifyForeground(123, 456)?.reason === 'activate-failed');
  check('回读不到前台（null）→ activate-failed，不得当成 ok',
    classifyForeground(123, null)?.reason === 'activate-failed');
  check('HWND 按数值比较（不是对象身份）',
    classifyForeground(9, 9)?.ok === true);

  // ---- 捕获：不抛，且形状正确（拿不到就 null）----
  let captured = null;
  let threw = false;
  try {
    captured = captureTarget();
  } catch {
    threw = true;
  }
  check('captureTarget() 不抛', threw === false);
  check('captureTarget() 返回 null 或 {kind, ...}',
    captured === null || (captured && typeof captured.kind === 'string'),
    JSON.stringify(captured));

  // ---- 编排顺序：确认到前台之前**绝不能发键** ----
  // 这是安全属性不是风格：发早了，Ctrl+V 会落到当时的前台窗口上，用户的文本就被粘进
  // 无关的应用。用假 platform 驱动 pasteWith，把这条顺序钉死。
  const mkPlatform = (activateResult) => {
    const calls = { activate: 0, send: 0 };
    return {
      calls,
      platform: {
        activate: async () => {
          calls.activate += 1;
          return activateResult;
        },
        sendPaste: () => {
          calls.send += 1;
        },
      },
    };
  };

  const failAct = mkPlatform({ ok: false, reason: 'permission' });
  const rFailAct = await pasteWith(failAct.platform, { kind: 'win', hwnd: 1 });
  check('activate 失败 → 透传 reason 且**一次键都不发**',
    rFailAct?.reason === 'permission' && failAct.calls.send === 0,
    JSON.stringify({ r: rFailAct, send: failAct.calls.send }));

  const mismatched = mkPlatform({ ok: true, id: 2 });
  const rMismatch = await pasteWith(mismatched.platform, { kind: 'win', hwnd: 1 });
  check('回读到的前台不是目标 → activate-failed 且**一次键都不发**',
    rMismatch?.reason === 'activate-failed' && mismatched.calls.send === 0,
    JSON.stringify({ r: rMismatch, send: mismatched.calls.send }));

  const good = mkPlatform({ ok: true, id: 1 });
  const rGood = await pasteWith(good.platform, { kind: 'win', hwnd: 1 });
  check('确认通过 → ok 且恰好发一次键',
    rGood?.ok === true && good.calls.send === 1,
    JSON.stringify({ r: rGood, send: good.calls.send }));

  const noTarget = mkPlatform({ ok: true, id: 1 });
  const rNoTarget = await pasteWith(noTarget.platform, null);
  check('target 为 null → no-target 且一次键都不发（也不调 activate）',
    rNoTarget?.reason === 'no-target' && noTarget.calls.activate === 0 && noTarget.calls.send === 0,
    JSON.stringify({ r: rNoTarget, calls: noTarget.calls }));

  const throwing = {
    calls: { send: 0 },
    platform: {
      activate: async () => {
        throw new Error('boom');
      },
      sendPaste: () => {
        throwing.calls.send += 1;
      },
    },
  };
  const rThrow = await pasteWith(throwing.platform, { kind: 'win', hwnd: 1 });
  check('activate 抛异常 → send-failed 且**不发键**（不得把异常漏给调用方）',
    rThrow?.reason === 'send-failed' && throwing.calls.send === 0,
    JSON.stringify({ r: rThrow, send: throwing.calls.send }));

  // ---- pasteTo 的入口守卫（真实置前与发键没法自动验）----
  const noTargetMac = await pasteTo(null);
  check('pasteTo(null) → no-target', noTargetMac?.reason === 'no-target',
    JSON.stringify(noTargetMac));

  // 形状不对的目标必须被**平台实现自己**挡掉。断言精确到 reason='no-target'：
  // 只断言 ok===false 是不够的 —— 平台实现若没做 kind 校验，会去解构不存在的 hwnd，
  // 要么抛（被 index 兜成 'send-failed'）要么把 undefined 当 0（'stale'），两种都会
  // 让 ok===false 成立，断言就变成了假绿。
  const wrongKind = await pasteTo({ kind: 'mac', pid: 1, bundleId: null });
  check('平台不匹配的目标被拒绝，且 reason 精确为 no-target',
    wrongKind?.reason === 'no-target', JSON.stringify(wrongKind));

  // ---- macOS 路径：Windows 上走不到，但可以验它不会被误调用 ----
  // 这条是防「index.js 的平台分派写反 / 平台实现忘了守 kind」的护栏。
  // 断言精确到 reason='no-target'（理由同 Task 3 那条：只看 ok===false 会假绿）。
  const macShaped = await pasteTo({ kind: 'mac', pid: process.pid, bundleId: null });
  check('Windows 上拒绝 mac 形状的目标，reason 精确为 no-target',
    macShaped?.reason === 'no-target', JSON.stringify(macShaped));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  for (const f of failed) console.log(`  FAIL ${f.name} ${f.detail}`);
  return { ok: failed.length === 0, failed: failed.length, total: results.length };
}
