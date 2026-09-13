# 采纳写回目标应用（Plan 2B）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 点「采纳」时把文本真正写回快捷键触发那一刻的前台窗口，失败则回退为「已复制，请手动粘贴」。

**Architecture:** 新增 `app/electron/inject/` 平台注入适配层，用 `koffi`（预编译、Node-API FFI）在进程内调平台 API：Windows 走 `user32.dll`（`GetForegroundWindow` / `SetForegroundWindow` / `keybd_event`），macOS 经 `libobjc` 的 `objc_msgSend` 调 AppKit（取/置前台应用）+ CoreGraphics `CGEventPost` 发 `Cmd+V`。前台窗口在 `SessionMachine.start()` 进 `warming` 之前捕获一次并随会话存活；采纳时由主进程置前 + 发粘贴键，回读前台确认成功。**剪贴板从不还原**。

**Tech Stack:** Electron 44（内置 Node 24）、React 19 + TS（Vite）、`node:sqlite`、`koffi`、自建自测（无第三方框架）。

**设计依据:** `docs/superpowers/specs/2026-09-13-adopt-injection-design.md`（下称 spec）。每个 Task 的隐含要求都包含 spec §0 的「明确接受的代价」——**不要把它们当缺陷修**。

## Global Constraints

- 平台：Windows 与 macOS 同等对待。**开发机是 Windows**，因此 Windows 路径能在本机自动验；**macOS 的加载与真机行为必须由用户在 Mac 上过**（见 Task 1 与 Task 8）。
- 测试无第三方框架：主进程 `cd app && VP_<NAME>_SELFTEST=1 npx electron .`；渲染进程 `cd app && npm run build && VP_UI_SELFTEST=1 npx electron .`（**必须先 build**，否则跑的是 `app/dist/renderer` 里的旧产物）；`cd app && npm run typecheck` 必须干净。
- i18n 三语齐全（`app/shared/i18n/{zh-CN,zh-TW,en-US}.js`），**不得在组件里硬编码文案**；`VP_I18N_SELFTEST` 比较三本字典的 key 集合，任何一本漏 key 都会红。
- **A2 不能破**：`warming / listening / draining` 三态窗口必须保持 `focusable:false` 且不抢焦点；只有 `reviewing` 可聚焦，且**不得调用 `focus()`**。
- **剪贴板从不还原**（spec §0 决策 2）。写入即留，成功失败一样。
- **绝不允许顶层 `koffi.load()`** —— 只准在函数内首次调用时惰性初始化。`index.js` 静态 import 了两个平台实现，顶层 `load` 会让 macOS 在启动时因 `load('user32.dll')` 抛异常而崩（spec §1）。
- 依赖：`app/package.json` 运行时依赖从 `opencc-js` + `ws` 变成三个（加 `koffi`）。**这是有意为之，不是疏忽**；除此之外不得再加任何依赖，且**不得引入需要编译器的依赖**（koffi 是预编译二进制）。
- 提交粒度：每个 Task 结束提交一次。
- **真实置前与粘贴无法自动测**。每个 Task 的自动测试只覆盖纯函数、生命周期与分发；真机验证集中在 Task 8 的清单。**自测全绿不代表功能可用**，任何 Task 的完成报告都必须说明哪些是自动验的、哪些只能真机验。

## File Structure

**新增**

| 文件 | 职责 |
|---|---|
| `app/electron/inject/index.js` | 平台分派、`captureTarget`、`pasteTo`、`classifyForeground`（纯函数）。**不含任何平台代码**，静态 import 两个平台实现 |
| `app/electron/inject/win.js` | koffi → `user32.dll`：`GetForegroundWindow` / `SetForegroundWindow` / `ShowWindow` / `AttachThreadInput` / `keybd_event`。导出 `captureTarget` / `activate` / `sendPaste` |
| `app/electron/inject/mac.js` | koffi → `libobjc`（`objc_msgSend`）/ CoreGraphics（`CGEvent*`）/ ApplicationServices（`AXIsProcessTrusted`）。导出 `captureTarget` / `activate` / `sendPaste` |
| `app/electron/selftest/inject.js` | 注入层自测入口（`VP_INJECT_SELFTEST`） |
| `docs/adopt-injection-test-runbook.md` | 真机验证清单（Task 8） |

**改动**

| 文件 | 改什么 |
|---|---|
| `app/package.json` | `dependencies` 加 `koffi`；`build.asarUnpack` 放出 `.node` |
| `app/electron/session/machine.js` | 构造参数加 `captureTarget`；`#target` 字段与 `getTarget()`；`start()` 进 warming 前捕获，`cancel`/`dismiss` 清空 |
| `app/electron/ipc.js` | 新增 `vp:adopt/paste` 通道 |
| `app/electron/preload.cjs`、`app/src/global.d.ts` | 暴露 `adoptPaste()` |
| `app/src/App.tsx` | `adopt` 改为「写剪贴板 → 调 `adoptPaste` → 成功关闭 / 失败提示」；新增 `ADOPT_FAIL_TEXT` |
| `app/shared/i18n/*` | 删 `bar.adopt.fallback`，加三条失败文案 |
| `app/src/uitest/run.tsx` | 假 bridge 加 `adoptPaste`；改写成功断言；补三条失败分支 |
| `app/electron/selftest/machine.js` | 新增 `testCaptureTarget` |
| `docs/plans/2026-09-05-voicepilot-prd.md`、`README.md`、`docs/plans/2026-08-31-engine-mvp-design.md` | 同步「采纳已实现」与未采纳项（Task 8） |

**不动的**：`app/electron/inject/` 之外没有任何新目录；不新增第三方依赖（koffi 是唯一一个）；不改 `app/src/studio/*`。

---

### Task 1: koffi 落地 + 自测入口（实施第一步的关卡）

这一 Task 是 spec §8 第 1 条的落地：**koffi 能不能在这个平台上加载并调用**。它不成立，后面全部无意义 —— 不成立就停下，回 spec 改路线（退回纯剪贴板方案）。

**Files:**
- Modify: `app/package.json`（`dependencies`、`build.asarUnpack`）
- Create: `app/electron/selftest/inject.js`
- Modify: `app/electron/main.js`（自测分派链）

**Interfaces:**
- Produces: `runInjectSelftest(): Promise<{ ok: boolean; failed: number; total: number }>`；自测开关 `VP_INJECT_SELFTEST=1`

- [ ] **Step 1: 安装 koffi**

Run: `cd app && npm install koffi`

Expected: 装完 `app/package.json` 的 `dependencies` 多出 `koffi`，且**没有任何编译输出**（koffi 自带预编译二进制，装的时候不需要编译器）。若这一步开始跑 node-gyp，说明拉到的是源码包 —— 停下报告，不要继续。

- [ ] **Step 2: 写自测（先写，后接线）**

Create `app/electron/selftest/inject.js`：

```js
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
    // 这里验的是「开发态能加载并调用 real user32」。
    // **不能**声称验了「打包后 .node 能被 dlopen」—— 那条只在打包版成立，见 Task 8 的 runbook。
    const user32 = koffi.load('user32.dll');
    const GetForegroundWindow = user32.func('uintptr_t GetForegroundWindow()');
    const hwnd = GetForegroundWindow();
    // 无人值守进程里可能没有前台窗口（返回 0），所以不断言具体值，只断言**类型对**。
    // 类型断言是关键：koffi 对 `void*` 返回的是指针值，不能用 !== 比数值相等
    // （每次都是新值 / 类型不同）。HWND 一律声明成 uintptr_t —— 实测 koffi 3.2.1 下
    // `uintptr_t` / `uint64_t` / `intptr_t` 返回的都是 **number**，number 可以直接 !== 比较。
    check('GetForegroundWindow() 返回可比较的数值（number）', typeof hwnd === 'number', String(typeof hwnd));
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
```

- [ ] **Step 3: 接进自测分派链**

`app/electron/main.js`：在 `VP_SHORTCUT_SELFTEST` 那一档之后追加一档。找到：

```js
                : process.env.VP_SHORTCUT_SELFTEST
                  ? './selftest/shortcut.js'
                  : null;
```

改为：

```js
                : process.env.VP_SHORTCUT_SELFTEST
                  ? './selftest/shortcut.js'
                  : process.env.VP_INJECT_SELFTEST
                    ? './selftest/inject.js'
                    : null;
```

再把下面 `const run = ...` 那一长串 `??` 链末尾补上 `?? mod.runInjectSelftest`：

```js
      const run = mod.runAsrSelftest ?? mod.runMachineSelftest ?? mod.runPolishSelftest ?? mod.runStoreSelftest ?? mod.runI18nSelftest ?? mod.runConfigSelftest ?? mod.runShortcutSelftest ?? mod.runInjectSelftest;
```

- [ ] **Step 4: 运行，确认通过**

Run: `cd app && VP_INJECT_SELFTEST=1 npx electron .`
Expected: 打印 `[自测] 注入层（inject）`，两项 `ok`，退出码 0。

**若这项失败**：不要改测试迁就实现。这正说明 koffi 在这台机器/这个 Electron 上加载不了 —— 停下报告，spec §2.4 的降级条件被触发。

- [ ] **Step 5: 处理打包（.node 出 asar）**

`app/package.json` 的 `build` 里、`"files"` 之后加：

```json
    "asarUnpack": [
      "node_modules/koffi/**",
      "node_modules/@koromix/**"
    ],
```

`node_modules/@koromix/**` 不是多余的：koffi 3.x 把原生二进制挪到了平台专属的可选依赖
`@koromix/koffi-<platform>-<arch>/` 下，**`node_modules/koffi/` 里一个 `*.node` 都没有**
（Task 1 实测），所以只写 `koffi/**` 是**空操作**，打包版只能押在 electron-builder 的
smartUnpack 上。显式写死而不依赖 smartUnpack：这一步错了只在打包版暴露，而打包版恰恰是
最难查的环境（见 `docs/macos-test-runbook.md` 记录的三个「只在打包版出现」的坑）。

- [ ] **Step 6: 确认没弄坏别的自测**

Run: `cd app && npm run typecheck`
Expected: 干净通过

Run: `cd app && VP_SHORTCUT_SELFTEST=1 npx electron .`
Expected: 通过，退出码 0（验证 Step 3 改动的分派链没串档）

- [ ] **Step 7: Commit**

```bash
git add app/package.json app/package-lock.json app/electron/selftest/inject.js app/electron/main.js
git commit -m "feat(inject): 引入 koffi + 注入层自测入口（实施第一步的关卡）"
```

> **交付给 Task 3/4 的结论（Task 1 实测，2026-09-13；必须据此写 Task 3 的实现）**：
> - koffi 3.2.1 装到的是**预编译包**（无编译步骤），`koffi.load('user32.dll')` 可用，`GetForegroundWindow()` 返回真实 HWND。
> - **`uintptr_t` / `uint64_t` / `intptr_t` 声明的返回值 → `number`；`void*` → bigint；`koffi.address(x)` → bigint。** 所以 HWND 用 `uintptr_t` 并用 `!==` 直接比数值即可，**不需要** `koffi.address()`。计划早期版本假设的「uintptr_t → bigint」是错的。
> - HWND 在 Windows 上远小于 2^53，`number` 不会有精度问题。

---

### Task 2: 注入层骨架 + Windows 捕获前台窗口

**Files:**
- Create: `app/electron/inject/index.js`
- Create: `app/electron/inject/mac.js`（先只放捕获的空实现，Task 4 补全）
- Create: `app/electron/inject/win.js`
- Modify: `app/electron/selftest/inject.js`

**Interfaces:**
- Consumes: Task 1 的 koffi 加载结论
- Produces:
  - `type Target = { kind: 'win'; hwnd: number } | { kind: 'mac'; pid: number; bundleId: string | null }`
  - `captureTarget(): Target | null`（`inject/index.js` 导出）
  - `classifyForeground(targetId, actualId): { ok: true } | { ok: false; reason: 'no-target' | 'activate-failed' }`（`inject/index.js` 导出，纯函数）

- [ ] **Step 1: 写 `inject/win.js` 的捕获**

Create `app/electron/inject/win.js`：

```js
import koffi from 'koffi';

/**
 * Windows 注入实现。
 *
 * ⚠️ 顶层绝不 koffi.load()：index.js 静态 import 了本文件，macOS 上
 * koffi.load('user32.dll') 会在应用启动时抛。所有动态库句柄都在 lib() 里惰性建。
 */

let api = null;

/** 惰性建一次动态库句柄与函数声明。 */
function lib() {
  if (api) return api;
  const user32 = koffi.load('user32.dll');
  api = {
    // HWND 一律用 uintptr_t。实测 koffi 3.2.1 下 uintptr_t 返回 **number**，可直接 !== 比较；
    // 不能用 `void*`（返回的是指针值，不可比数值）。
    GetForegroundWindow: user32.func('uintptr_t GetForegroundWindow()'),
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
```

- [ ] **Step 2: 写 `inject/index.js`（分派 + 纯函数）**

Create `app/electron/inject/index.js`：

```js
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
```

- [ ] **Step 3: 写 `inject/mac.js` 的捕获占位（Task 4 补全）**

Create `app/electron/inject/mac.js`：

```js
/**
 * macOS 注入实现。
 *
 * ⚠️ 顶层绝不 koffi.load()：index.js 静态 import 了本文件。所有动态库句柄都在
 * lib() 里惰性建。
 */
export function captureTarget() {
  // Task 4 实现。在此之前返回 null —— 采纳会走「已复制，请手动粘贴」的回退路径，
  // 而不是崩溃。
  return null;
}
```

- [ ] **Step 4: 加自测断言**

`app/electron/selftest/inject.js`：把 `import koffi from 'koffi';` 之后加上

```js
import { captureTarget, classifyForeground } from '../inject/index.js';
```

并在 `const failed = results.filter(...)` **之前**插入：

```js
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
```

- [ ] **Step 5: 运行**

Run: `cd app && VP_INJECT_SELFTEST=1 npx electron .`
Expected: 全部 `ok`，退出码 0。

Run: `cd app && npm run typecheck`
Expected: 干净通过

- [ ] **Step 6: Commit**

```bash
git add app/electron/inject/ app/electron/selftest/inject.js
git commit -m "feat(inject): 平台分派 + Windows 捕获前台窗口 + 置前判定纯函数"
```

---

### Task 3: Windows 置前 + 发 Ctrl+V

**Files:**
- Modify: `app/electron/inject/win.js`
- Modify: `app/electron/inject/index.js`
- Modify: `app/electron/selftest/inject.js`

**Interfaces:**
- Consumes: Task 2 的 `Target` / `classifyForeground`
- Produces:
  - `inject/index.js`：`pasteTo(target: Target | null): Promise<{ ok: true } | { ok: false; reason: string }>`
  - `inject/index.js`：`pasteWith(platform, target)` —— 同一编排，但平台实现是参数，便于自测驱动「确认失败就不发键」这条安全属性
  - 平台模块（本 Task 是 `win.js`）导出**两个原语**，不是单个 `pasteTo`：
    - `activate(target): Promise<{ ok: true; id: number } | { ok: false; reason: string }>` —— 只切前台并回读
    - `sendPaste(): void` —— 只发粘贴键（Windows `keybd_event` / macOS `CGEventPost`）
  - 「确认到前台 → 发键」的先后由 `index.js` 一处编排；Task 4 必须照同一形状实现

- [ ] **Step 1: 扩充 `inject/win.js`**

把 `lib()` 替换为下面这版（补齐其余 user32/kernel32 声明），并在文件末尾追加 **`sendPaste` 与 `activate` 两个函数** —— 不是单个 `pasteTo`（理由见 Step 2）：

```js
const SW_RESTORE = 9;
const VK_CONTROL = 0x11;
const VK_V = 0x56;
const KEYEVENTF_KEYUP = 0x0002;
// 置前是异步的：SetForegroundWindow 返回时目标未必已经真的拿到前台。
// 60ms 是起点不是承诺（spec §8 第 7 条），真机不合就在 Task 8 调。
const ACTIVATE_WAIT_MS = 60;

let api = null;

function lib() {
  if (api) return api;
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  api = {
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
```

追加：

```js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读当前前台句柄；拿不到返回 null。 */
function readForeground() {
  const hwnd = lib().GetForegroundWindow();
  return hwnd ? hwnd : null;
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
  a.keybd_event(VK_CONTROL, 0, 0, 0);
  a.keybd_event(VK_V, 0, 0, 0);
  a.keybd_event(VK_V, 0, KEYEVENTF_KEYUP, 0);
  a.keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
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

  await sleep(ACTIVATE_WAIT_MS);
  return { ok: true, id: readForeground() };
}
```

- [ ] **Step 2: 在 `index.js` 里补 `pasteTo` 分派**

在 `app/electron/inject/index.js` 末尾追加：

```js
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
```

> `index.js` 的 `pasteTo` 用 `target.hwnd ?? target.pid` 取「目标标识」，因此 Windows 传 HWND、macOS 传 pid，都是同一行。
>
> **平台模块必须导出两个原语 —— `activate(target)` 与 `sendPaste()` —— 而不是一个 `pasteTo`。** 这样「确认到前台」与「发键」的先后由 `index.js` 一处编排（`pasteWith`），纯函数判定也留在 `index.js`（有自测）。**Task 4 的 macOS 实现必须照这个形状写**（`activate` + `sendPaste`），不要写成单个 `pasteTo`，也**不要改 `index.js`**。

- [ ] **Step 3: 加自测断言**

`app/electron/selftest/inject.js` 里，在 `const failed = results.filter(...)` **之前**追加：

```js
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
  //
  // ⚠️ 必须做平台守卫：这个自测文件在 macOS 上也会跑，而那里 `impl` 是 `mac`，
  // `pasteTo({kind:'mac'})` 会走到**真实的** `mac.activate` —— 这条断言会红在
  // 「'permission' 或 'stale'，但不是 'no-target'」上，而且是用一个真实 pid 去激活
  // 真实应用。它验的是 **win.js 的 kind 守卫**，在 macOS 上本就无从验。
  if (process.platform === 'win32') {
    const wrongKind = await pasteTo({ kind: 'mac', pid: 1, bundleId: null });
    check('平台不匹配的目标被拒绝，且 reason 精确为 no-target',
      wrongKind?.reason === 'no-target', JSON.stringify(wrongKind));
  }
```

并把顶部 import 改为：

```js
import { captureTarget, classifyForeground, pasteTo, pasteWith } from '../inject/index.js';
```

- [ ] **Step 4: 运行**

Run: `cd app && VP_INJECT_SELFTEST=1 npx electron .`
Expected: 全部 `ok`，退出码 0。其中 `平台不匹配的目标被拒绝，且 reason 精确为 no-target` 在 Windows 上验的就是 `win.js` 对 `kind:'mac'` 的处理。

Run: `cd app && npm run typecheck`
Expected: 干净通过

- [ ] **Step 5: Commit**

```bash
git add app/electron/inject/index.js app/electron/inject/win.js app/electron/selftest/inject.js
git commit -m "feat(inject): Windows 置前（含 AttachThreadInput 兜底）+ 发 Ctrl+V"
```

---

### Task 4: macOS 实现（koffi + libobjc + CGEventPost）

**这是整套里最脆的一段**：经 `objc_msgSend` 调 ObjC 需要把返回类型声明对，写错了不报错、只会拿到野指针。开发机是 Windows，**本 Task 的代码在 Windows 上只能做语法与分派层面的验证，真实行为必须由用户在 Mac 上验**（Task 8 清单一）。

**Files:**
- Modify: `app/electron/inject/mac.js`
- Modify: `app/electron/selftest/inject.js`

**Interfaces:**
- Consumes: Task 2 的 `Target` / `classifyForeground`
- Produces: `mac.captureTarget(): Target | null`、`mac.activate(target): Promise<{ ok: true; id: number } | { ok: false; reason: string }>`、`mac.sendPaste(): void`
  - **必须是 `activate` + `sendPaste` 两个原语，不是单个 `pasteTo`** —— 与 Task 3 的 Windows 侧同形，「确认到前台 → 才发键」的先后由 `index.js` 编排。

- [ ] **Step 1: 实现 `inject/mac.js`**

替换整个文件：

```js
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
  // activateWithOptions: 的参数是 NSUInteger（64 位），**必须声明成 64 位**：声明成
  // uint32_t 时 koffi 只写寄存器的低 32 位，高 32 位是什么由 ABI 决定，目标可能读到一个
  // 天文数字的 options。传 number 即可（Task 1 实测 uintptr_t 与 number 互通）。
  //
  // 返回类型是 **BOOL**（方法签名 `- (BOOL)activateWithOptions:`），不是 void。
  // 但**不要使用这个返回值**：macOS 14 起该位（IgnoringOtherApps）已被弃用，实测常见
  // 「返回 YES 却没真的置前」。本设计的成功判据是**回读前台窗口**那一条（spec §3），
  // 多一个会骗人的判据只会引入误报。声明成 bool 只是为了让声明与 API 一致。
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
```

> **降级退路（不是默认，只在实测否决 ObjC 方案后启用）**：若 `objc_msgSend` 那五个声明怎么调都不对，激活改用 `/usr/bin/open -b <bundleId>`（免 ObjC，只起一个进程），发键仍用 `CGEventPost`。代价是多窗口应用可能被拉到别的窗口，与「目标窗口 = 触发那刻的前台窗口」不完全一致。**启用它必须回 spec §4.2 改决策**，不要在实现里偷偷换。

- [ ] **Step 2: 确认 `index.js` 的编排认得 macOS**

Task 3 写的 `index.js` 的 `pasteTo` 是：`impl.activate(target)` → `classifyForeground(target.hwnd ?? target.pid, a.id)` → `impl.sendPaste()`。对 macOS 它走 `target.pid`，并且调用 `mac.activate` / `mac.sendPaste`。

**读一遍 `app/electron/inject/index.js` 确认这三行都在**；`mac.js` 必须导出同名的 `activate` 与 `sendPaste`（本 Task 的 Step 1 已经这么写了），否则 `index.js` 会在运行时抛 `impl.activate is not a function`。**不要去改 `index.js`** —— 两侧形状由 Task 3 定稿。

- [ ] **Step 3: 扩展自测（Windows 上验不到真实行为，但要验「不抛 + 形状」）**

`app/electron/selftest/inject.js`，在 `const failed = results.filter(...)` **之前**追加：

```js
  // ---- macOS 路径：**必须做平台守卫** ----
  // ⚠️ 这个自测文件本身有 darwin 分支（见 Task 1 的 `process.platform === 'darwin'`），
  // 所以它会真的在 macOS 上跑。而在 macOS 上 `impl` 就是 `mac`，`pasteTo({kind:'mac'})`
  // **不会**命中 win.js 的 kind 守卫，而是走到真实的 `mac.activate`：
  //   - 断言 `reason === 'no-target'` 在 macOS 上必红；
  //   - 更糟的是若用 `pid: process.pid`（我们自己）且已授权，它会真的激活本应用、
  //     回读匹配、然后**发出一次真正的 Cmd+V** —— 自测朝当时的前台窗口打按键。
  // 所以这里用 win32 守卫：这两条验的是 **Windows 平台的 kind 守卫**，在 macOS 上
  // 本来就无从验，跳过即可。macOS 侧的真实行为归 Task 8 的真机清单。
  if (process.platform === 'win32') {
    const macShaped = await pasteTo({ kind: 'mac', pid: process.pid, bundleId: null });
    check('Windows 上拒绝 mac 形状的目标，reason 精确为 no-target',
      macShaped?.reason === 'no-target', JSON.stringify(macShaped));
  }
```

> **Windows 上验不到的东西（必须原样写进 Task 8 的清单与完成报告）**：
> - `objc_msgSend` 的五个声明是否都对（每个声明对应哪个方法、返回宽度是否匹配）；
> - `AXIsProcessTrusted` **能否从 ApplicationServices 伞形框架里解析到符号**（该符号实际在 HIServices，靠伞形框架再导出；若解析不到，`lib()` 会在首次使用时抛）；
> - `frontPid()` 是否真的返回前台应用 pid；`pid === process.pid` 这条自查护栏所依赖的「`frontmostApplication` 返回主进程 pid」这一 Electron 进程模型假设是否成立；
> - `activateWithOptions:` 是否真能把目标应用拉到前台（`IgnoringOtherApps` 位自 macOS 14 起已弃用，实测常见「调用成功但没到前台」）；
> - `CGEventPost` 在授予辅助功能权限后是否真的粘上。

- [ ] **Step 4: 运行**

Run: `cd app && VP_INJECT_SELFTEST=1 npx electron .`
Expected: 全部 `ok`，退出码 0。

Run: `cd app && npm run typecheck`
Expected: 干净通过

- [ ] **Step 5: Commit**

```bash
git add app/electron/inject/mac.js app/electron/selftest/inject.js
git commit -m "feat(inject): macOS 实现（libobjc 取/置前台应用 + CGEventPost 发 Cmd+V）"
```

---

### Task 5: 状态机捕获目标窗口 + IPC 通道 + 桥

**Files:**
- Modify: `app/electron/session/machine.js`
- Modify: `app/electron/ipc.js`
- Modify: `app/electron/preload.cjs`
- Modify: `app/src/global.d.ts`
- Modify: `app/electron/selftest/machine.js`

**Interfaces:**
- Consumes: Task 2/3 的 `captureTarget()` / `pasteTo(target)`
- Produces:
  - `SessionMachine` 构造参数新增可选 `captureTarget?: () => Target | null`；新增方法 `getTarget(): Target | null`
  - IPC `vp:adopt/paste` → `{ ok: true } | { ok: false, reason: string }`
  - bridge `adoptPaste(): Promise<{ ok: true } | { ok: false; reason: 'no-target' | 'stale' | 'activate-failed' | 'send-failed' | 'permission' }>`

- [ ] **Step 1: 状态机——注入捕获并持有目标**

`app/electron/session/machine.js`：

顶部 import 之后加：

```js
import { captureTarget as defaultCaptureTarget } from '../inject/index.js';
```

`#fixedCreds = null;` 之后加字段：

```js
  #captureTarget;
  #target = null;
```

构造函数参数列表加 `captureTarget`，并在 `this.#fixedCreds = credentials ?? null;` 之后加：

```js
    // 与 createSession 同一个注入手法：生产用真实现，自测注入假的。
    // 不把平台代码写进状态机 —— 这里只认「一个返回 Target|null 的函数」。
    this.#captureTarget = captureTarget ?? defaultCaptureTarget;
```

`getSnapshot()` 之后加：

```js
  /** 快捷键触发那一刻的前台窗口。采纳时用它作为写回目标。 */
  getTarget() {
    return this.#target;
  }
```

`start()` 里，把 `this.#setState('warming');` 之前紧接着插入：

```js
    // 必须在进 warming 之前捕获：那之后悬浮条开始渲染，前台随时可能变成我们自己。
    // 也要在凭据校验之后 —— 校验失败会直接 return，那时不该留下一个陈旧目标。
    this.#target = this.#captureTarget();
```

`#cancel()` 与 `#dismiss()` 里各加一行 `this.#target = null;`（前者紧跟 `this.#queue.clear();`，后者紧跟 `this.#queue.clear();`）。

- [ ] **Step 2: 加状态机自测**

`app/electron/selftest/machine.js`：在 `testBarFocusable` 之后加一个新函数：

```js
// ---------------------------------------------------------------- 采纳目标窗口

/**
 * 采纳写回的目标窗口：捕获时机与生命周期。
 * 捕获**必须在进 warming 之前**发生 —— 那之后悬浮条开始渲染，前台可能变成我们自己。
 */
async function testCaptureTarget() {
  console.log('\n[8] 采纳目标窗口：捕获时机与生命周期');

  let calls = 0;
  let stateAtCapture = null;
  let session = null;
  const holder = {};
  const m = new SessionMachine({
    emit() {},
    // 会话卡在「建立中」：start() 才会停在 warming，第二次 toggle 才走「取消」路径。
    // 不 hold 的话 start() 直接进 listening，toggle 会变成 stop → draining → reviewing，
    // 那验的就是另一条生命周期了（而且 reviewing 不清空目标，两条断言会假红）。
    createSession: () => {
      session = new FakeSession({});
      session.startHeld = true;
      return session;
    },
    credentials: {},
    captureTarget: () => {
      calls += 1;
      stateAtCapture = holder.m.state;
      // 必须是 number，不能写 7n：Target 的 hwnd 就是 number（koffi 实测），
      // 而且下面 check 的 detail 参数会被**立即求值**，JSON.stringify(7n) 会抛，
      // 整轮自测直接中断。
      return { kind: 'win', hwnd: 7 };
    },
  });
  holder.m = m;

  // 不能 await：会话被 hold 住，await 会一直挂 —— 而 warming 恰恰就是这段等待窗。
  // 捕获跑在第一个 await 之前，所以这一行调用之后目标就已经取好了。
  const pending = m.start();
  await tick();
  check('start 时捕获一次', calls === 1, `捕获 ${calls} 次`);
  check('捕获发生在进 warming 之前', stateAtCapture === 'idle', String(stateAtCapture));
  check('目标已持有', m.getTarget() !== null, JSON.stringify(m.getTarget()));

  await m.toggle(); // warming → 取消
  check('取消后清空目标', m.getTarget() === null, JSON.stringify(m.getTarget()));
  check('取消后回到 idle', m.state === 'idle', m.state);

  // 放行被取消的会话，让 start() 的 promise 收尾，别留下悬挂的 pending。
  session.releaseStart();
  await pending;
}
```

在 `runMachineSelftest()` 里、`await testBarFocusable();` 之后加：

```js
  await testCaptureTarget();
```

> **为什么这里不验「捕获实现抛异常时状态机兜得住」**：兜底责任在 `inject/index.js` 的 `captureTarget`（它自己 try/catch 并返回 null），不在状态机 —— 状态机只认「一个返回 `Target|null` 的函数」这个契约，不该替实现擦屁股。给状态机加 try/catch 会把真实现里的 bug 一起吞掉。那条契约由 `VP_INJECT_SELFTEST` 的 `captureTarget() 不抛` 覆盖（Task 2）。

> **本 Task 的基线不是 29 而是 34。** 计划早期写的「29 + 5 = 34」已过时（2A 的 `testBarFocusable` 等新增用例把它推到了 34）。实测：改动前 **34** 项、改动后 **39** 项。**报实际观测值，不要为了让数字对上而改断言。**

- [ ] **Step 3: 加 IPC 通道**

`app/electron/ipc.js`：

顶部 import 之后加：

```js
import { pasteTo } from './inject/index.js';
```

在 `vp:copy` handler 之后加：

```js
  /**
   * 采纳写回：把剪贴板里的文本粘到「快捷键触发那一刻的前台窗口」。
   *
   * 剪贴板由渲染进程先经 vp:copy 写好，这里只负责置前 + 发粘贴键 ——
   * 这样「复制」与「采纳」共用同一条剪贴板写入路径，不会出现两边写的内容不一致。
   * **不还原剪贴板**（spec §0 决策 2）。
   */
  ipcMain.handle('vp:adopt/paste', () => pasteTo(machine.getTarget()));
```

> `machine` 在 `registerIpc` 里是 `const machine = new SessionMachine({ emit });`，因此这里无需改它的构造 —— 生产路径走 `captureTarget` 的默认实现。

- [ ] **Step 4: 暴露到桥与类型**

`app/electron/preload.cjs`，在 `copy(text)` 之后加：

```js
  /**
   * 采纳写回：把剪贴板内容粘到「快捷键触发那一刻的前台窗口」。
   * **调用前必须先用 copy() 把文本写进剪贴板。**
   * 返回 { ok:true } 或 { ok:false, reason }。
   */
  adoptPaste() {
    return ipcRenderer.invoke('vp:adopt/paste');
  },
```

`app/src/global.d.ts`，在 `copy(text: string): Promise<boolean>;` 之后加：

```ts
  /**
   * 采纳写回：把剪贴板内容粘到「快捷键触发那一刻的前台窗口」。
   * 调用前必须先用 copy() 写好剪贴板。失败时 reason 说明原因。
   */
  adoptPaste(): Promise<
    | { ok: true }
    | { ok: false; reason: 'no-target' | 'stale' | 'activate-failed' | 'send-failed' | 'permission' }
  >;
```

- [ ] **Step 5: 运行**

Run: `cd app && npm run typecheck`
Expected: 干净通过

Run: `cd app && VP_SM_SELFTEST=1 npx electron .`
Expected: 通过。**此时总数应为 34 + 5 = 39**（改前实测 34 项 + `testCaptureTarget` 的 5 项；计划早期写的 29 是过时基线）；若不是 39，说明自测没接进 `runMachineSelftest`。Run: `cd app && VP_INJECT_SELFTEST=1 npx electron .`
Expected: 通过

> ⚠️ **本条无法自动验**：`vp:adopt/paste` 真的把前台切过去并粘上。IPC 通道本身在界面自测里（Task 7）只验「有没有被调用、参数对不对」。

- [ ] **Step 6: Commit**

```bash
git add app/electron/session/machine.js app/electron/ipc.js app/electron/preload.cjs app/src/global.d.ts app/electron/selftest/machine.js
git commit -m "feat(adopt): 状态机捕获目标窗口 + 采纳写回 IPC 与桥"
```

---

### Task 6: 采纳改造 + 三语失败文案 + 界面自测同步（先红后绿）

**Files:**
- Modify: `app/src/App.tsx`（`adopt` 回调；`ADOPT_FAIL_TEXT` 映射表）
- Modify: `app/shared/i18n/zh-CN.js`、`zh-TW.js`、`en-US.js`
- Modify: `app/src/uitest/run.tsx`（假 bridge 的 `adoptPaste`；第 23 段末尾的提示断言）

**Interfaces:**
- Consumes: Task 5 的 `vp.adoptPaste()`
- Produces: 无新导出；行为契约 = 采纳成功则关闭悬浮条，失败则保留悬浮条并给出按原因区分的提示

- [ ] **Step 1: 加三语文案（替换掉 `bar.adopt.fallback`）**

`bar.adopt.fallback` 在新流程里没有位置了（成功不再给提示，而是直接关闭），删掉它，换成三条失败文案。

`app/shared/i18n/zh-CN.js`，把

```js
  'bar.adopt.fallback': '已复制到剪贴板，请手动粘贴（自动写回尚未实现）',
```

替换为：

```js
  'bar.adopt.fail': '自动写回失败，已复制到剪贴板，请手动粘贴',
  'bar.adopt.fail.staleTarget': '目标窗口已关闭，已复制到剪贴板，请手动粘贴',
  'bar.adopt.fail.permission': '未获得辅助功能权限，无法自动写回。已复制到剪贴板，请手动粘贴',
```

`app/shared/i18n/zh-TW.js`，把对应的那行替换为：

```js
  'bar.adopt.fail': '自動寫回失敗，已複製到剪貼簿，請手動貼上',
  'bar.adopt.fail.staleTarget': '目標視窗已關閉，已複製到剪貼簿，請手動貼上',
  'bar.adopt.fail.permission': '未取得輔助使用權限，無法自動寫回。已複製到剪貼簿，請手動貼上',
```

`app/shared/i18n/en-US.js`，把对应的那行替换为：

```js
  'bar.adopt.fail': 'Auto-insert failed — copied to clipboard, please paste manually',
  'bar.adopt.fail.staleTarget': 'Target window is gone — copied to clipboard, please paste manually',
  'bar.adopt.fail.permission': 'Accessibility permission missing, cannot auto-insert. Copied to clipboard, please paste manually',
```

- [ ] **Step 2: 先把界面自测改到「新行为」，跑出红**

新行为是「成功 → 关闭 + 无提示；失败 → 保留 + 提示」。**先改断言，再改实现** —— 否则改完实现跑一次绿，谁也说不清那条断言到底还有没有在验东西。

`app/src/uitest/run.tsx`：在 holders 区（`const barPolishError` 附近，约 82 行）加：

```tsx
  // 采纳写回的返回值由每条用例自己摆：默认「成功」，Task 7 的失败分支按 reason 改。
  // 它必须**显式**挂在假 bridge 上 —— `...real` 复制不到 contextBridge 的非枚举属性
  // （见本文件 copy 那段的注释）。缺了它 App 调 vp.adoptPaste() 会抛 TypeError，
  // async 函数静默 reject，表现是「点了采纳毫无反应」。
  const adoptPasteCtl: { result: { ok: true } | { ok: false; reason: string }; calls: number } = {
    result: { ok: true },
    calls: 0,
  };
```

在 `bridge` 对象里、`copy` 之后加：

```tsx
    adoptPaste: () => {
      adoptPasteCtl.calls += 1;
      return Promise.resolve(adoptPasteCtl.result);
    },
```

把第 23 段末尾那段提示断言（约 863–876 行，`const adoptHintNodes = ...` 到 `check('采纳成功后提示区只有兜底一条...')` 的整块）替换为：

```tsx
  // 采纳成功 = 真写回成功 → 悬浮条关闭，且**不该有任何提示**。
  // 旧形态（复制 + 兜底提示）已不存在：提示只在写回失败时出现。
  check('采纳成功时调用了写回通道', adoptPasteCtl.calls === 1, `${adoptPasteCtl.calls} 次`);
  check('采纳成功后关闭悬浮条', toggleCount === toggleBefore + 1, `${toggleBefore} → ${toggleCount}`);
  check('采纳成功不留任何提示节点',
    container.querySelectorAll('[data-testid^="bar-hint"]').length === 0,
    JSON.stringify(Array.from(container.querySelectorAll('[data-testid^="bar-hint"]')).map((n) => n.textContent)));
```

并在 `clickButton('采纳')`（约 848 行）**之前**加一行记基线：

```tsx
  const toggleBefore = toggleCount;
```

第 23 段原有的三条断言 —— 「采纳取润色结果」「采纳把润色结果回写历史」「采纳回写携带会话历史 id」—— **保持不动**：它们验的是文本选材与历史 id，与新行为无关。

Run: `cd app && npm run build && VP_UI_SELFTEST=1 npx electron .`
Expected: **红**，失败的正是 `采纳成功后关闭悬浮条`（此刻渲染进程还在走旧的「复制 + 提示」路径，既不调 `adoptPaste` 也不 `toggle`）。**确认失败的项名就是这条再往下走** —— 若红在别处（例如 `adoptPasteCtl.calls === 1` 也红，那是对的；但若红在 i18n 或崩溃，就是改错了地方）。

- [ ] **Step 3: 改 `adopt`**

`app/src/App.tsx`：`adopt` 回调（约在 494–523 行）整体替换为：

```tsx
  /**
   * 采纳：把「当前有效文本」写进剪贴板，再让主进程把它粘回**快捷键触发那一刻的
   * 前台窗口**。
   *
   * 剪贴板从不还原（spec 2026-09-13 §0），所以失败时文本仍在剪贴板里 —— 失败的
   * 后果是「没省一步」而不是「文本丢了」，这也是失败分支敢直接给提示的原因。
   */
  const adopt = useCallback(async () => {
    await persistEdited();
    // 有润色结果时把它作为「采用后的正式文本」回写历史。
    // 回写失败不阻塞采纳：界面闭环优先。
    if (polishOut.length > 0) {
      try {
        await vp.adoptPolish({
          // 必须显式带上本条会话的历史 id，理由见 2A 的 Critical 修复（ee1ab8a）。
          id: historyIdRef.current ?? undefined,
          polished: polishOut,
          scene: scene?.name ?? '',
          tone: tone?.name ?? '',
        });
      } catch {
        /* 回写失败不阻塞采纳 */
      }
    }

    const ok = await vp.copy(effectiveText);
    if (!ok) {
      showError({ kind: 'clipboard', message: t('bar.err.clipboard') });
      return;
    }

    // 剪贴板已写好，现在置前 + 发粘贴键。主进程返回的 reason 决定提示文案。
    let r: Awaited<ReturnType<typeof vp.adoptPaste>>;
    try {
      r = await vp.adoptPaste();
    } catch (e) {
      // IPC 拒绝（主进程未就绪等）。当作一次普通失败，不能让异常冒成
      // unhandled rejection 把悬浮条卡在无提示的状态。
      r = { ok: false, reason: 'send-failed' };
      console.warn(`[采纳] 写回通道失败：${e instanceof Error ? e.message : String(e)}`);
    }
    if (r.ok) {
      // 写回成功：与「复制」同一收尾（reviewing 下 toggle 的语义就是关闭）。
      void vp.toggle();
      return;
    }
    setHint(ADOPT_FAIL_TEXT[r.reason] ?? t('bar.adopt.fail'));
  }, [effectiveText, polishOut, persistEdited, scene, tone, vp, t]);
```

- [ ] **Step 4: 加文案映射表**

`app/src/App.tsx` 里，紧挨现有的 `ERROR_TEXT` 定义（约 92–99 行）之后加：

```tsx
  // 采纳写回失败的文案。用显式映射而不是拼 key（`bar.adopt.fail.${reason}`）：
  // t() 对缺 key 的处理是**原样返回 key**，拼串会让漏翻译直接显示成一串英文 key，
  // 而显式映射漏了会落到下面的 ?? 兜底。
  const ADOPT_FAIL_TEXT: Record<string, string> = {
    stale: t('bar.adopt.fail.staleTarget'),
    permission: t('bar.adopt.fail.permission'),
  };
```

> `no-target` / `activate-failed` / `send-failed` 都不进这张表 —— 它们对用户是同一件事（「没写回去」），共用 `bar.adopt.fail` 一条文案。区分它们只对排障有意义，日志里已经有。

- [ ] **Step 5: 运行，确认转绿**

Run: `cd app && npm run typecheck`
Expected: 干净通过

Run: `cd app && VP_I18N_SELFTEST=1 npx electron .`
Expected: 通过（三本字典 key 集合一致；删 `bar.adopt.fallback`、加三条新 key 后仍一致）

Run: `cd app && npm run build && VP_UI_SELFTEST=1 npx electron .`
Expected: **Step 2 里红的那条现在绿了**，全部通过、退出码 0。若仍红，说明实现与断言对不上 —— 先查 `adopt` 有没有真的在 `r.ok` 分支调 `vp.toggle()`。

Run: `cd app && VP_SM_SELFTEST=1 npx electron .`
Expected: 39/39 通过（Task 5 之后的总数）

- [ ] **Step 6: Commit**

```bash
git add app/src/App.tsx app/shared/i18n/zh-CN.js app/shared/i18n/zh-TW.js app/shared/i18n/en-US.js app/src/uitest/run.tsx
git commit -m "feat(adopt): 采纳改为真写回，「已复制请手动粘贴」降级为失败分支"
```

---

### Task 7: 界面自测补齐三条写回失败分支

Task 6 已经覆盖了成功路径。这一 Task 补上失败路径 —— 它是「剪贴板从不还原」这个决策的兑现：**失败时文本仍在剪贴板里**，所以提示必须明确告诉用户「已经复制好了，手动粘」。

**Files:**
- Modify: `app/src/uitest/run.tsx`

**Interfaces:**
- Consumes: Task 6 建好的 `adoptPasteCtl`（`{ result, calls }`）与 `toggleCount`
- Produces: 无新导出；覆盖 `activate-failed` / `permission` / `stale` 三条 reason 分支

- [ ] **Step 1: 加失败分支断言**

在第 23 段之后新增一段（沿用本文件 `enterReviewing()`、`clickButton`、`flush`）：

```tsx
  // ---- 23b. 采纳写回失败：保留悬浮条 + 按 reason 给提示 ----
  await enterReviewing();
  copyCtl.text = null;
  const toggleBeforeFail = toggleCount;
  adoptPasteCtl.result = { ok: false, reason: 'activate-failed' };
  adoptPasteCtl.calls = 0;
  clickButton('采纳');
  await flush();
  check('写回失败时确实调了写回通道', adoptPasteCtl.calls === 1, `${adoptPasteCtl.calls} 次`);
  check('写回失败时不关闭悬浮条', toggleCount === toggleBeforeFail,
    `${toggleBeforeFail} → ${toggleCount}`);
  check('写回失败时剪贴板已写好（不还原）', copyCtl.text !== null, JSON.stringify(copyCtl.text));
  check('activate-failed 给出通用失败提示',
    container.querySelector('[data-testid="bar-hint-adopt"]')?.textContent ===
      '自动写回失败，已复制到剪贴板，请手动粘贴',
    JSON.stringify(container.querySelector('[data-testid="bar-hint-adopt"]')?.textContent));

  // permission 必须给**不同**的文案：它是唯一可操作的失败（去 F12 授权），
  // 若与通用文案混同，macOS 用户拿不到「该去授权」这个提示。
  await enterReviewing();
  adoptPasteCtl.result = { ok: false, reason: 'permission' };
  clickButton('采纳');
  await flush();
  check('permission 给出可操作的不同文案',
    container.querySelector('[data-testid="bar-hint-adopt"]')?.textContent ===
      '未获得辅助功能权限，无法自动写回。已复制到剪贴板，请手动粘贴',
    JSON.stringify(container.querySelector('[data-testid="bar-hint-adopt"]')?.textContent));

  // stale 同理，指向「目标窗口没了」这个具体原因。
  await enterReviewing();
  adoptPasteCtl.result = { ok: false, reason: 'stale' };
  clickButton('采纳');
  await flush();
  check('stale 指出目标窗口已关闭',
    container.querySelector('[data-testid="bar-hint-adopt"]')?.textContent ===
      '目标窗口已关闭，已复制到剪贴板，请手动粘贴',
    JSON.stringify(container.querySelector('[data-testid="bar-hint-adopt"]')?.textContent));

  // 复位，避免影响后面的用例（第 24 段起还会复用这棵 App 树）
  adoptPasteCtl.result = { ok: true };
```

> `enterReviewing()` 每次都会把状态从 idle 重走一遍，而 `hint` 在 `idle → warming` 的复位块里被清空（`app/src/App.tsx:266`），所以三条分支之间不会互相看到对方的提示。**若某条断言红了但提示文本是上一条的**，说明复位块被动过 —— 那不是测试的问题。

- [ ] **Step 2: 运行，确认通过**

Run: `cd app && npm run build && VP_UI_SELFTEST=1 npx electron .`
Expected: 全部通过，退出码 0；总数比 Task 6 之后多 6 项。

Run: `cd app && npm run typecheck`
Expected: 干净通过

- [ ] **Step 3: Commit**

```bash
git add app/src/uitest/run.tsx
git commit -m "test(adopt): 界面自测覆盖写回失败的三条 reason 分支"
```

---

### Task 8: 文档同步 + 真机验证清单

**Files:**
- Modify: `docs/plans/2026-09-05-voicepilot-prd.md`（F5 / §4.3 / §8 M5-A）
- Modify: `README.md`
- Modify: `docs/plans/2026-08-31-engine-mvp-design.md`（§D5 标注未采纳）
- Modify: `docs/superpowers/specs/2026-09-13-adopt-injection-design.md`（§8 待验证项逐条记结论）
- Create: `docs/adopt-injection-test-runbook.md`

**Interfaces:** 无代码接口

- [ ] **Step 1: 更新 PRD**

`docs/plans/2026-09-05-voicepilot-prd.md` 的 F5 与 §4.3：把「采纳当前为『复制 + 提示手动粘贴』（写回目标应用见 Plan 2B，尚未实现）」改为「采纳把文本写回快捷键触发那一刻的前台窗口；失败回退为『已复制，请手动粘贴』」；§8 M5-A 里相应项同步。**不要改写其它小节。**

- [ ] **Step 2: 更新 README**

把「注入光标未做」（约 211 行）改为已实现，并写明天花板：管理员权限窗口收不到、终端与部分特殊控件粘贴行为不一致、中文 IME 组字态可能吞掉 Ctrl+V、剪贴板不还原。

- [ ] **Step 3: 标注 engine-mvp §D5 的两处未采纳**

`docs/plans/2026-08-31-engine-mvp-design.md` §D5：在「注入后恢复用户原剪贴板内容」与「终端类应用回退 SendInput 逐字注入」两条上标明**本实现未采纳**，并各写一句原因（改为从不还原；终端直接走失败回退）。

- [ ] **Step 4: 写真机验证 runbook**

Create `docs/adopt-injection-test-runbook.md`，照 `docs/macos-test-runbook.md` 的写法（踩坑导向、写清「打包版才暴露」这类环境差异）。内容至少包含：

- **未授权路径**（macOS）：未授予辅助功能时点采纳 → 悬浮条不关闭、提示「未获得辅助功能权限…」→ 深链跳系统设置 → 授权后立刻再点一次 → 成功。
- **目标应用矩阵**（Win 与 Mac 各一遍）：记事本 / 浏览器输入框 / 终端 / Office 各采纳一次，记录成功/失败与现象。
- **管理员窗口**（Win）：用管理员身份运行记事本，确认失败时悬浮条不关闭、提示可见、剪贴板里文本仍在。**这是已接受的代价，验的是「失败可感知」，不是「能写进去」。**
- **A2 回归**：在别的应用里持续打字，中途触发快捷键听写 → 焦点不跳、字继续落回原输入框。
- **剪贴板语义**：采纳成功后剪贴板里就是这段文本（从不还原）。**明确验这一条**，因为它是与 09-12 设计相反的决策。
- **最小化 / 已关闭的目标窗口**：触发前把目标窗口最小化 → 采纳应能还原并粘贴；触发后关掉目标窗口 → 采纳应报 `stale` 且不关闭悬浮条。
- **打包版专项**（Win 与 Mac 都要）：`npm run dist:win` / `dist:mac` 后从安装产物启动，确认 ① koffi 的 `.node` 能从 asar 外被加载（Task 1 的 asarUnpack 生效）② macOS arm64 上未签名 `.node` 能 dlopen；**这两条不成立就是 spec §2.4 的降级条件被触发**。

- [ ] **Step 5: 把 Task 1–7 的实测结论回写 spec §8**

`docs/superpowers/specs/2026-09-13-adopt-injection-design.md` 的 §8 有 8 条待验证项。逐条在末尾补 `**结论（2026-09-XX）**：`，写明实测结果。**没验到的不要写「应该没问题」** —— 写「未验，原因」。第 1/2/3 条（加载、asarUnpack、签名）与第 5/6 条（`activateWithOptions:`、`objc_msgSend`）在 Windows 上验不到，必须留到 Mac 上。

- [ ] **Step 6: 全量回归**

Run: `cd app && npm run typecheck`
Run: `cd app && VP_STORE_SELFTEST=1 npx electron .`
Run: `cd app && VP_I18N_SELFTEST=1 npx electron .`
Run: `cd app && VP_SM_SELFTEST=1 npx electron .`
Run: `cd app && VP_SHORTCUT_SELFTEST=1 npx electron .`
Run: `cd app && VP_INJECT_SELFTEST=1 npx electron .`
Run: `cd app && npm run build && VP_UI_SELFTEST=1 npx electron .`

Expected: 全部通过，退出码 0。

- [ ] **Step 7: Commit**

```bash
git add docs/plans/2026-09-05-voicepilot-prd.md README.md docs/plans/2026-08-31-engine-mvp-design.md docs/superpowers/specs/2026-09-13-adopt-injection-design.md docs/adopt-injection-test-runbook.md
git commit -m "docs: 同步采纳写回的实现形态 + 真机验证 runbook"
```

---

## 收尾验证

自动可验的部分（在开发机 Windows 上跑完）：

- [ ] `cd app && npm run typecheck`
- [ ] `cd app && VP_INJECT_SELFTEST=1 npx electron .`
- [ ] `cd app && VP_SM_SELFTEST=1 npx electron .`
- [ ] `cd app && VP_STORE_SELFTEST=1 npx electron .`
- [ ] `cd app && VP_I18N_SELFTEST=1 npx electron .`
- [ ] `cd app && VP_SHORTCUT_SELFTEST=1 npx electron .`
- [ ] `cd app && npm run build && VP_UI_SELFTEST=1 npx electron .`

**只能真机验的部分**（不跑完这些，不得声称 Plan 2B 完成）：

- [ ] Windows 真机：`docs/adopt-injection-test-runbook.md` 的矩阵全过，含管理员窗口与最小化/已关闭窗口
- [ ] macOS 真机：同一份 runbook 全过，含未授权 → 授权 → 成功这条路径
- [ ] 打包版：Win 与 Mac 各一次，确认 koffi 的 `.node` 能加载（asarUnpack 与 arm64 签名）
- [ ] A2 回归：聆听三态仍然不抢焦点

## 本计划不含（留给后续）

- 终端逐字注入回退（`SendInput` + `KEYEVENTF_UNICODE`）—— spec §0 代价 2
- 中文 IME 组字态检测与清空 —— spec §0 代价 3
- 管理员窗口提权 —— spec §0 代价 1
- 剪贴板还原 —— 已被 2026-09-13 决策明确取消
