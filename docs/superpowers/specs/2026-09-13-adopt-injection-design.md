# 采纳写回目标应用设计（Plan 2B）

- **日期**: 2026-09-13
- **状态**: 待评审
- **上游**: `docs/superpowers/specs/2026-09-12-trial-feedback-design.md` §2（本文件补全其明确推迟的注入部分）；`docs/plans/2026-09-05-voicepilot-prd.md` F5 / §4.3 / §8 M5-A；`docs/plans/2026-08-31-engine-mvp-design.md` §D5（历史设计，本期部分不采纳）
- **来源**: 2026-09-12 试用反馈第 2 条「采纳后直接插入到此前正在操作的应用」
- **范围**: 只做「采纳 → 把文本写回快捷键触发那一刻的前台窗口」。
  **不含**：终端逐字注入回退、中文 IME 组字态检测与清空、管理员窗口提权、剪贴板还原。
  以上四项在 §0「明确接受的代价」里逐条说明，**不要在 review 里当缺陷重开**。

## 0. 已拍板的关键决策

| 决策 | 结论 | 依据 |
|---|---|---|
| 注入路线 | **统一 koffi**：Windows 与 macOS 用同一套 FFI 手法。**不用** `osascript`、**不用** PowerShell、不引入 node-gyp 原生模块 | 用户拍板 2026-09-13 |
| 剪贴板 | **从不还原**。文本写进剪贴板后就留着，成功失败都一样 | 用户拍板 2026-09-13；与 2026-09-06「复制不恢复」原则一致 |
| 注入机制 | 剪贴板 + 模拟 Ctrl/Cmd+V | 沿用 09-12 §2.2 |
| 目标窗口 | 快捷键触发那一刻的前台窗口（中途切应用则写回旧窗口） | 沿用 09-12 |
| 采纳文本 | 有润色结果送润色结果，否则送编辑后原文 | 沿用 09-12 |
| 平台范围 | Windows + macOS 同步 | 沿用 09-12 |
| 是否先做 spike | 否。依赖与打包验证作为实施第一步 | 沿用 09-12 §2.4 |

### 明确接受的代价（不修）

1. **管理员权限窗口（Windows UIPI）收不到非提权进程的合成按键** → 采纳静默失败。
2. **终端与部分特殊控件的粘贴行为不一致** → 不做逐字注入回退，用户手动粘。
3. **中文 IME 组字态可能吞掉 Ctrl+V** → 本期不检测、不清空合成状态。
4. **用户中途切了应用仍写回旧窗口** → 目标窗口在触发那刻就固定了。
5. **静默失败不可检**。见 §3 的成功判据：我们能确认「置前成功了」，无法确认「粘贴被目标应用消费了」。管理员窗口这类漏报是这条的直接后果。

> 以上是选型的直接代价，不是缺陷。若将来试用范围变化（例如必须支持管理员窗口），先回头改本表，再动实现。

## 1. 模块边界

新增 `app/electron/inject/`，四个文件，各自职责单一：

| 文件 | 职责 | 依赖 |
|---|---|---|
| `inject/index.js` | 平台分派 + 唯一对外接口。**不含任何平台代码** | 静态 `import` 两个平台实现 |
| `inject/win.js` | koffi → `user32.dll` | `koffi` |
| `inject/mac.js` | koffi → `libobjc` / AppKit / CoreGraphics / ApplicationServices | `koffi` |
| `electron/selftest/inject.js` | 纯函数自测（reason 归类、Target 生命周期、分派），与其余自测同目录 | 无 |

对外接口只有两个：

```ts
type Target =
  | { kind: 'win'; hwnd: number }
  | { kind: 'mac'; pid: number; bundleId: string | null };

type PasteResult =
  | { ok: true }
  | { ok: false; reason: 'no-target' | 'stale' | 'activate-failed' | 'send-failed' | 'permission' };

/** 取当前前台窗口。同步、进程内，失败不抛，返回 null。 */
export function captureTarget(): Target | null;

/** 把剪贴板内容粘贴到 target。调用方负责先写好剪贴板。 */
export function pasteTo(target: Target | null): Promise<PasteResult>;
```

**`index.js` 静态 import 两个平台实现，靠 `process.platform` 分派**，不做惰性 `import()` —— 惰性 `import()` 是异步的，而 `captureTarget()` 必须同步，两者打架。之所以可以静态 import：koffi 在 Windows 与 macOS 上都能正常加载，两个平台实现同时在内存里没有副作用。

**硬性约束：平台模块可以在顶层 `import koffi`，但绝不能在顶层调用 `koffi.load()`。** 在 macOS 上 `koffi.load('user32.dll')` 会抛异常，而 `index.js` 静态 import 了 `win.js`，顶层 `load` 就等于让应用在启动时炸。动态库句柄一律**在函数内首次调用时惰性初始化**。

`pasteTo` 是 `async` 而不是同步：置前与发键之间要隔一个短延时（§4），**不能用忙等** —— 阻塞主进程事件循环会连带卡住 ASR 会话与状态广播。

## 2. 捕获时机与生命周期

- `SessionMachine` 构造参数新增 `captureTarget`（默认 `inject/index.js` 的真实现）。这里沿用本文件既有的注入手法（`createSession` 就是为自测注入而存在的），不把平台代码写进状态机。
- `start()` 里、`#setState('warming')` **之前**同步调用一次，结果存 `#target`。必须在 warming 之前：那时前台还是用户的工作应用；warming 之后悬浮条开始渲染。
- `getTarget()` 供 `ipc.js` 的采纳通道读取。
- `#cancel()` 与 `#dismiss()` 里清空 `#target`。
- **不做 fire-and-forget**：koffi 是进程内同步调用（微秒级），没有需要藏起来的延迟。保持同步最简单。

## 3. 采纳流程与成功判据

```
adopt():
  text = effectiveText                        // 有润色用润色，否则编辑区（与 2A 一致）
  await persistEdited()                       // 更新历史正文（与 2A 一致）
  if (有润色) await adoptPolish(...)           // 回写历史润色字段（与 2A 一致）
  ok = await vp.copy(text)                    // 剪贴板照写（唯一输出终点没变）
  if (!ok) → 现有剪贴板错误提示，结束
  r = await vp.adoptPaste()                   // 新增桥方法 → IPC vp:adopt/paste → inject.pasteTo(machine.getTarget())
  r.ok ? 关闭悬浮条
       : setHint(按 reason 分支的文案)；不关闭悬浮条
```

历史在这一步之前就已经落好了（进 reviewing 时落一次、编辑后更新一次），所以成功分支只剩「关闭悬浮条」这一个动作。

**成功判据 = 「目标窗口确实到了前台」，不是「粘贴被消费了」。**

后者原理上不可检：`keybd_event` 只报告事件已入队，不报告目标应用是否处理。前者可检，且覆盖最常见的失败（置前被系统拒绝）。因此：置前后回读一次前台窗口，不等于目标就判 `activate-failed`。

因为**从不还原剪贴板**，失败时剪贴板里仍是文本 —— 与 2A 的行为完全一致，用户可以直接手动粘。这条让「失败」的后果从"文本丢失"降级为"没省一步"，也是 §0 决策 2 的主要收益。

## 4. 平台实现

### 4.1 Windows —— `inject/win.js`

| 步骤 | 调用 |
|---|---|
| 捕获 | `user32.GetForegroundWindow()` → HWND |
| 失效校验 | `user32.IsWindow(hwnd)`；false → `stale` |
| 解最小化 | `user32.IsIconic(hwnd)` 为真则 `user32.ShowWindow(hwnd, SW_RESTORE=9)` |
| 置前 | `user32.SetForegroundWindow(hwnd)` |
| 置前兜底 | 失败时 `GetWindowThreadProcessId` 取目标线程 id → `AttachThreadInput` 把自己挂上去 → 重试 → 卸载 |
| 确认 | 回读 `user32.GetForegroundWindow()`，不等于目标 → `activate-failed` |
| 间隔 | 等约 60ms（`setTimeout`，不阻塞事件循环） |
| 发键 | `user32.keybd_event`：`VK_CONTROL(0x11)`↓ → `VK_V(0x56)`↓ → `VK_V`↑ → `VK_CONTROL`↑，抬起用 `KEYEVENTF_KEYUP(0x0002)` |

**用 `keybd_event` 而不是 `SendInput`**：本场景只需要一次四键组合，用不上 `SendInput` 的批量能力；而 `SendInput` 要声明 `INPUT` 联合体，在 x64 下有 4 字节对齐填充（结构体应为 40 字节），是个容易写错且错了不报错的坑。`keybd_event` 已废弃但仍在 user32 里正常工作，签名只有四个标量参数。

**不做管理员窗口检测**：判定目标进程完整性级别要 `OpenProcess` + `GetTokenInformation` + 比较 SID，成本高于收益，而后果（静默失败）已列在 §0。

### 4.2 macOS —— `inject/mac.js`

| 步骤 | 调用 |
|---|---|
| 捕获 | `objc_msgSend(objc_getClass('NSWorkspace'), sel_registerName('sharedWorkspace'))` → `frontmostApplication` → `processIdentifier`；顺带取 `bundleIdentifier`（可能为 nil） |
| 权限前置 | `AXIsProcessTrustedWithOptions`（ApplicationServices）；未授权 → `permission`，不尝试注入 |
| 失效校验 | `runningApplicationWithProcessIdentifier:` 返回 nil，或 `isTerminated` 为真 → `stale` |
| 置前 | `activateWithOptions:`（带 `NSApplicationActivateAllWindows`，让目标应用的所有窗口一起上来） |
| 确认 | 回读 `frontmostApplication` 的 pid，不等于目标 → `activate-failed` |
| 间隔 | 等约 120ms（比 Windows 长：macOS 应用激活与窗口提升是异步的） |
| 发键 | `CGEventCreateKeyboardEvent(nil, 0x09 /*V*/, true)` → `CGEventSetFlags(ev, kCGEventFlagMaskCommand = 1<<20)` → `CGEventPost(kCGHIDEventTap = 0, ev)`；同样发一次 key-up |

**加载的动态库**：`/usr/lib/libobjc.A.dylib`、`/System/Library/Frameworks/AppKit.framework/AppKit`、`/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics`、`/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices`。

**权限只要一项**：辅助功能。`CGEventPost` 与 `AXIsProcessTrustedWithOptions` 同属这一项，正好接上现有 `vp:permission/status`（`app/electron/ipc.js:386`）与 F12 的引导/深链。**F12 引导不需要扩**。

**已知最脆的一段**：经 `objc_msgSend` 调 ObjC 方法需要 koffi 正确声明 `libobjc` 的 C 函数与返回类型，写错了不会报错、只会拿到野指针。这是本设计里最需要真机迭代的部分。

**退路（降级选项，不是默认）**：若 ObjC 这段实测过于脆弱，激活改用 `/usr/bin/open -b <bundleId>`（免 ObjC，只起一个进程）。代价是多窗口应用可能被拉到别的窗口 —— 与「目标窗口 = 触发那刻的前台窗口」的承诺不完全一致。此路只在 ObjC 方案被实测否决后启用，且需回到本文件改决策。

## 5. 依赖与打包

- `app/package.json` 的 `dependencies` 增 `koffi`（预编译二进制、Node-API）。**版本在实施时按当时 npm 最新稳定版锁定**，不预先写死。
- **这是本项目第一个运行时原生依赖**。此前刻意只留 `opencc-js` + `ws`（并为了躲开 `better-sqlite3` 的 electron-rebuild 而选了内置 `node:sqlite`）。koffi 与之的关键差别是：预编译、N-API（跨 Electron 版本 ABI 稳定）、安装时**不需要编译器、不需要 electron-rebuild**。
- **asarUnpack**：`.node` 在 asar 内无法 `dlopen`。先验证 electron-builder 的 smartUnpack 是否已自动处理；没有就在 `build` 配置里显式加 `asarUnpack`。
- **macOS 包现在会带 koffi 的 `.node`**，arm64 上存在「未签名二进制能否 `dlopen`」的问题。若失败，在 afterPack 钩子里对 koffi 的 `.node` 做 adhoc 签名（`codesign -s -`）。**这是实施第一步必须验的头号问题。**
- **不需要**：`osascript` 相关的一切、`NSAppleEventsUsageDescription`（自动化权限的 Info.plist 说明）—— 因为路线里没有 Apple Events。
- 新增自测入口 `VP_INJECT_SELFTEST=1`，接入 `app/electron/main.js` 的自测分派链。

## 6. 测试

**可自动测**（`VP_INJECT_SELFTEST=1`，`app/electron/selftest/inject.js`）：

- 平台分派的选路（给定平台标识，选中对应实现）；
- `reason` 归类：把各平台的原始失败信号（Windows `IsWindow` 假 / 置前后回读不等；macOS `runningApplicationWithProcessIdentifier:` 返回 nil / 未授权）映射到 5 个 `reason` 的纯函数；
- Target 生命周期：未捕获就采纳 → `no-target`。

**不可自动测，只能真机**：真实的置前与粘贴。**这是本设计的核心风险，必须诚实对待**——自测全绿不代表功能可用。

**界面自测**（`app/src/uitest/run.tsx`，假 bridge）覆盖三条分支：

1. 无捕获目标 → 提示 + 不关闭；
2. 注入失败 → 提示 + 不关闭 + 剪贴板保留文本；
3. 注入成功 → 关闭悬浮条 + 历史已落库。

**真机验证清单**（Windows 与 macOS 各过一遍）：

- 记事本 / 浏览器输入框 / 终端 / Office 各采纳一次；
- **管理员权限窗口**（用管理员身份运行的记事本）—— 确认失败时悬浮条不关闭且提示可见；
- **回归 A2**：聆听三态仍然不抢焦点（在别的应用里持续打字不受影响）；
- macOS 额外：未授予辅助功能时采纳给出 `permission` 提示并能跳 F12 深链；授予后立即生效。

## 7. 与既有文档的关系

### 7.1 已随本设计同步（2026-09-13）

| 文档 | 改动 |
|---|---|
| 本文件 | 新增 |
| `2026-09-12-trial-feedback-design.md` §0 决策表「采纳写入机制」 | 「成功后还原用户剪贴板」→ **从不还原** |
| 同上 §1「本批未实施」表 | 落点改为 koffi 四文件 + `machine.js`／`ipc.js`／`package.json`，并注明不还原剪贴板 |
| 同上 §2 顶部注 | 从「注入留 Plan 2B」改为指向本文件，并列出两处更正 |
| 同上 §2.2 | 删掉「备份用户剪贴板」「还原用户剪贴板」两步；补上成功判据 |
| 同上 §2.3 | 「不还原剪贴板」不再是失败分支独有的行为；失败判据补「窗口已失效」「未获辅助功能权限」 |
| 同上 §2.4 | 「实现第一步先选定并验证依赖」→「验证已定的 koffi 路线（含 mac arm64 的 dlopen/签名）」 |
| 同上 §9 | F12 前置仍是**一项**（辅助功能），但原因从 `osascript` 改为 `CGEventPost`；明确不涉及 Apple Events |
| 同上 §11 待验证第 1 条 | 关闭（选型已定） |

### 7.2 已随 Plan 2B 实施同步（2026-09-13）

> 下表三项原本写「待实现落地时同步」（描述的是**已交付行为**，提前改会骗人）。实现已落地，**三项均已按本表同步完毕**；实测结论见 §8。

| 文档 | 改动 |
|---|---|
| `docs/plans/2026-09-05-voicepilot-prd.md` F5 / §4.3 / §8 M5-A | 「采纳当前为复制 + 提示手动粘贴（尚未实现）」→「采纳写回目标应用已实现；失败回退复制」 |
| `README.md` | 「注入光标未做」→ 已实现（尽力而为 + 失败回退）；注明管理员窗口与终端的天花板 |
| `docs/plans/2026-08-31-engine-mvp-design.md` §D5 | 标注两处**未采纳**：「注入后恢复用户原剪贴板内容」改为从不还原；「终端类应用回退 SendInput 逐字注入」本期不做，终端直接走失败回退 |

## 8. 待验证 / 实现时定的点

1. **koffi 能否在 Windows 与 macOS（arm64、打包版）加载并调用** —— 实施第一步。
   **结论（2026-09-13）**：**Windows 开发机已实测**——`koffi@3.2.1` 预编译安装、无编译器步骤；`koffi.load('user32.dll')` 成功；`GetForegroundWindow()` 返回真实 HWND（`uintptr_t` 返回 **`number`**，可直接 `!==` 比较；`void*` 返回 `bigint`）。**macOS（arm64）与两个平台的打包版未验（需 Mac 真机 / 打包产物）**：从未在 macOS 上执行过。验法与判据见 `docs/adopt-injection-test-runbook.md` 用例 7 与用例 1–2。
2. **asarUnpack 是否生效**（smartUnpack 自动处理，还是需要显式配置）。
   **结论（2026-09-13）**：**已实测（Windows 开发机）**，且**必须显式配**。koffi 3.x 的原生二进制在 `node_modules/@koromix/koffi-<platform>-<arch>/`，**不在** `node_modules/koffi/`，所以只写 `node_modules/koffi/**` 是空操作。已改为 `["node_modules/koffi/**", "node_modules/@koromix/**"]`（`app/package.json`）。A/B 证据：`electron-builder --win --dir` + `-c.asar.smartUnpack=false`，旧 glob 下 `.node` 留在 asar 内（`unpacked=false`），新 glob 下移出（asar 缩小约 1.04 MB，与 `koffi.node` + `koffi.lib` 吻合），产物实测在 `release/win-unpacked/resources/app.asar.unpacked/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node`，1,036,800 B。⚠️ **这只证明文件「移出去了」，不证明应用能「加载它」**——后者属第 1 条的未验部分。
3. **macOS arm64 上 `.node` 的 adhoc 签名**是否需要 afterPack 钩子。
   **结论（2026-09-13）**：**未验（需 Mac 真机 + 打包产物）**。当前**没有**加 afterPack 钩子。若打包版启动即报 koffi 加载失败，再加 `codesign -s -`；验法与降级判据见 runbook 用例 7 ②/降级条件。
4. `SetForegroundWindow` 被前台锁拒绝的实际频率，以及 `AttachThreadInput` 兜底是否够用。
   **结论（2026-09-13）**：**未验（需真机）**。开发机上只探过一次兜底路径要用的 `GetWindowThreadProcessId(hwnd, null)`，返回了合理线程 id、未抛异常；但**拒绝频率与兜底是否真能把窗口置前都没测过**。验法：runbook 用例 2 / 6a，观察是否报 `activate-failed`。
5. `activateWithOptions:` 在新系统上已弃用，在 macOS 14+ 的实际行为需实测（必要时改用 `activateFromApplication:options:`）。
   **结论（2026-09-13）**：**未验（需 Mac 真机）**。实现已按「它会骗人」处理——**故意丢弃返回值**，成功判据只用「回读前台 pid」（`app/electron/inject/mac.js` 的 `msgSendBoolUPtr` 注释）。真机仍需确认两件事：① 它到底能不能把目标应用置前；② 若不能，是否改用 `activateFromApplication:options:`。
6. **`objc_msgSend` 经 koffi 的脆弱度** —— 若不可用，走 §4.2 的 `open -b` 退路。
   **结论（2026-09-13）**：**未验（需 Mac 真机）**。macOS 实现自写出后**从未执行过**，以下全部待验：五个 `objc_msgSend` 声明（`msgSendPtr` / `msgSendI32` / `msgSendCStr` / `msgSendPtrI32` / `msgSendBoolUPtr`）的形状正确性；`AXIsProcessTrusted` 能否从 ApplicationServices umbrella framework 解析出符号（符号实际在 HIServices）；`frontPid()` 是否返回真实前台 pid；`pid === process.pid` 自守的前提（`frontmostApplication` 报的是我们主进程 pid）是否成立；`CGEventPost` 在授权后是否真的粘贴一次。全部通过前不得启用 `open -b` 退路，也不得改本决策。
7. 置前与发键之间的间隔在各平台上定稿（Windows 60ms / macOS 120ms 是起点，不是承诺）。
   **结论（2026-09-13）**：**未验（需真机）**，仍取起点值——Windows 60ms（`app/electron/inject/win.js`）、macOS 120ms（`app/electron/inject/mac.js`）。真机若出现「窗口置前了但按键发早/发晚」，按 runbook 记录现象后再调这两个常量。
8. 各失败 `reason` 对应的中文文案（三语齐全，走 `app/shared/i18n/*`）。
   **结论（2026-09-13）**：**已实测（Windows 开发机，自动化）**。5 个 `reason` 的三语文案已落在 `app/shared/i18n/{zh-CN,zh-TW,en-US}.js`，i18n 三语键齐自测通过；渲染层用显式映射（`app/src/App.tsx` 的 `ADOPT_FAIL_TEXT`）而不是拼 key，`permission` / `stale` 有独立文案，界面自测锁定了 zh-CN 原文。⚠️ **未验的是真机上能否分别触发到这几个 `reason`**（即失败归类的实际正确性），见 runbook 用例 1 / 3 / 6。
