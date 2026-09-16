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

对外接口只有两个（业务只跟这两个打交道）：

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

> 除上面两个对外接口外，`index.js` 还导出 `classifyForeground` 与 `pasteWith`。它们不是对外 API，而是**刻意的测试接缝**：`classifyForeground` 是把失败映射成 `reason` 的纯函数，`pasteWith(platform, target)` 让自测能用假平台把「确认到前台 → 才发键」这条顺序约束钉死（真机验一次不能防回归）。接缝是**承重**的 —— 删掉它就丢掉顺序断言的唯一抓手 —— 不是随手多导出的。业务侧仍然只调 `captureTarget` / `pasteTo`。

> **已接受的启动期风险**：因为 `machine.js` 静态 import `inject/index.js`，而 koffi 在 import 时解析其 `.node`，所以打包版若加载 koffi 失败（macOS arm64 未签名 `.node` 无法 `dlopen`、asarUnpack 未生效等）**是应用启动即致命**，不是「采纳退化」。这条把 §5 的打包验证从「功能验收」升级为「启动门槛」：`dlopen` 不成立就没有降级路径可走。

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

**`adoptPolish` 的 `id` 三态**（2026-09-13 实现）：悬浮条一路**总是显式传 `id`**——本条会话的历史 id，当前 reviewing 没有历史行时传 `null`（例如从常用语来的采纳）；Studio 一路**整体省略该字段**，由主进程回落到 `pendingHistoryId`。显式 `null`（不写库）与「省略」（写 Studio 上次打开那条）是两种语义，由 `app/electron/store.js` 的纯函数 `resolvePolishTarget(id, pendingHistoryId)` 实现并配自测钉住。

历史在这一步之前就已经落好了（进 reviewing 时落一次、编辑后更新一次），所以成功分支只剩「关闭悬浮条」这一个动作。

**成功判据 = 「目标窗口确实到了前台」，不是「粘贴被消费了」。**

后者原理上不可检：`SendInput` 只报告事件已入队，不报告目标应用是否处理。前者可检，且覆盖最常见的失败（置前被系统拒绝）。因此：置前后回读一次前台窗口，不等于目标就判 `activate-failed`。

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
| 发键 | `user32.SendInput`：**一次调用**投递整批 `[Ctrl↓, V↓, V↑, Ctrl↑]` 的 `INPUT`（`type=INPUT_KEYBOARD`），抬起用 `KEYEVENTF_KEYUP(0x0002)` |

**必须用 `SendInput` 的批量投递，不能用四次独立的 `keybd_event`**（这是真机踩出来的根因，2026-09-13）：修饰键与目标键必须**原子**地进输入流。四次独立调用时 `Ctrl` 的按下常常还没生效，`V`/`A` 就已经被目标处理 —— `Ctrl+V` 退化成裸字符 `V`、`Ctrl+A` 退化成裸 `A`。真机现象是「Word 里冒出一个 A」「记事本碰巧能用，Word / 浏览器 / 终端时灵时不灵」。**规划早期为躲开 `INPUT` 联合体的对齐坑而刻意选了 `keybd_event`，那个取舍正是这个 bug 的来源。** 对齐改由 `koffi.sizeof` 正面解决：x64 下 `INPUT` 实测为 **40 字节**，并已用自测断言钉住（`INPUT_SIZE === 40`，见 `app/electron/selftest/inject.js`）—— 尺寸写错 `SendInput` 只会返回 0，属于静默失效，不能只靠肉眼。

**不做管理员窗口检测**：判定目标进程完整性级别要 `OpenProcess` + `GetTokenInformation` + 比较 SID，成本高于收益，而后果（静默失败）已列在 §0。

### 4.2 macOS —— `inject/mac.js`

| 步骤 | 调用 |
|---|---|
| 捕获 | `objc_msgSend(objc_getClass('NSWorkspace'), sel_registerName('sharedWorkspace'))` → `frontmostApplication` → `processIdentifier`；顺带取 `bundleIdentifier`（可能为 nil） |
| 权限前置 | `AXIsProcessTrusted`（ApplicationServices）；未授权 → `permission`，不尝试注入 |
| 失效校验 | `runningApplicationWithProcessIdentifier:` 返回 nil → `stale`。**只判 nil**：加 `isTerminated` 分支是**推迟的候选**（应用进程仍在、仅窗口被关时 `isTerminated` 未必为真），当前实现不含，见 `app/electron/inject/mac.js:164` |
| 置前 | `activateWithOptions:`（带 `NSApplicationActivateAllWindows`，让目标应用的所有窗口一起上来） |
| 确认 | 回读 `frontmostApplication` 的 pid，不等于目标 → `activate-failed` |
| 间隔 | 等约 120ms（比 Windows 长：macOS 应用激活与窗口提升是异步的） |
| 发键 | `CGEventCreateKeyboardEvent(nil, 0x09 /*V*/, true)` → `CGEventSetFlags(ev, kCGEventFlagMaskCommand = 1<<20)` → `CGEventPost(kCGHIDEventTap = 0, ev)`；同样发一次 key-up |

**加载的动态库**：`/usr/lib/libobjc.A.dylib`、`/System/Library/Frameworks/AppKit.framework/AppKit`、`/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics`、`/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices`。

**权限只要一项**：辅助功能。`CGEventPost` 与 `AXIsProcessTrusted` 同属这一项，正好接上现有 `vp:permission/status`（`app/electron/ipc.js:386`）与 F12 的引导/深链。**F12 引导不需要扩**。

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
   **结论（2026-09-13）**：**Windows 开发机与 Windows 打包版均已实测**——`koffi@3.2.1` 预编译安装、无编译器步骤；`koffi.load('user32.dll')` 成功；`GetForegroundWindow()` 返回真实 HWND（`uintptr_t` 返回 **`number`**，可直接 `!==` 比较；`void*` 返回 `bigint`）。
   **打包版实测**：`npm run build && npx electron-builder --win --dir` 产出后，直接跑 `release/win-unpacked/VoicePilot.exe` 并带 `VP_INJECT_SELFTEST=1` → **17/17 通过、退出码 0**（该次运行的断言数；review 后追加 `INPUT` / `GUITHREADINFO` 两条结构体尺寸断言，当前共 **19** 项），其中 `captureTarget()` 在打包版内取到真实 HWND（`{"kind":"win","hwnd":393822}`）。**这证明 `.node` 确实从 asar 外被 dlopen 并调用成功**，不再只是「文件被移出去了」。
   **结论（2026-09-16）**：**macOS（arm64）已补齐，本条结清。** 开发模式（2026-09-15，控制台启动）与**打包版（2026-09-16，从 Finder 启动）**都跑过：`koffi` 在 macOS 上能加载并调用（阶段 0 的 `VP_INJECT_SELFTEST=1` 得 **24/24**）。**Windows 的真实置前 + 粘贴已于 2026-09-13 真机通过**（Word / 浏览器 / 终端，光标留在目标应用），macOS 侧随 2026-09-16 那轮一并通过（含 `2590057` 修后的两个问题）。验法与判据见 `docs/adopt-injection-test-runbook.md` 用例 7 与用例 1–2。
2. **asarUnpack 是否生效**（smartUnpack 自动处理，还是需要显式配置）。
   **结论（2026-09-13）**：**已实测（Windows 开发机）**，且**必须显式配**。koffi 3.x 的原生二进制在 `node_modules/@koromix/koffi-<platform>-<arch>/`，**不在** `node_modules/koffi/`，所以只写 `node_modules/koffi/**` 是空操作。已改为 `["node_modules/koffi/**", "node_modules/@koromix/**"]`（`app/package.json`）。A/B 证据：`electron-builder --win --dir` + `-c.asar.smartUnpack=false`，旧 glob 下 `.node` 留在 asar 内（`unpacked=false`），新 glob 下移出（asar 缩小约 1.04 MB，与 `koffi.node` + `koffi.lib` 吻合），产物实测在 `release/win-unpacked/resources/app.asar.unpacked/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node`，1,036,800 B。
   ✅ **「应用能加载它」这一半也已在 Windows 打包版实测通过**（2026-09-13，见第 1 条）：打包版跑 `VP_INJECT_SELFTEST=1` 得 17/17、退出码 0，并在包内取到真实前台 HWND。**macOS arm64 的同一问题已于 2026-09-16 在打包版实测通过**（从 Finder 启动，`.node` 能 `dlopen`），见第 3 条。
3. **macOS arm64 上 `.node` 的 adhoc 签名**是否需要 afterPack 钩子。
   **结论（2026-09-13）**：**未验（需 Mac 真机 + 打包产物）**。当时**没有**加 afterPack 钩子；若打包版启动即报 koffi 加载失败，再加 `codesign -s -`；验法与降级判据见 runbook 用例 7 ②/降级条件。
   **结论（2026-09-16）**：**已验 —— 不需要这个钩子。** macOS arm64 打包版（`npm run dist:mac`，从 Finder 启动）里 `.node` 能正常 `dlopen`、启动**不报** koffi 加载错误，且打包版内跑通了 TextEdit 那一格 ⇒ runbook 用例 7 的**降级条件未触发**，**不退回纯剪贴板方案**，`afterPack` 保持不添加。
4. `SetForegroundWindow` 被前台锁拒绝的实际频率，以及 `AttachThreadInput` 兜底是否够用。
   **结论（2026-09-13，Windows 真机日志）**：**在已观察到的运行里，兜底根本没有被用到** —— 前台窗口在约 **13–48ms** 内到位，`SetForegroundWindow` 直接成功，`AttachThreadInput` 分支未触发，也未复现 `activate-failed`。⚠️ 这只是**观测**，不是测得的拒绝频率：样本有限（真机试用数次），**不能据此删掉兜底分支**。macOS 侧走 `activateWithOptions:`，无此问题。完整验法仍是 runbook 用例 2 / 6a。
5. `activateWithOptions:` 在新系统上已弃用，在 macOS 14+ 的实际行为需实测（必要时改用 `activateFromApplication:options:`）。
   **结论（2026-09-13）**：**未验（需 Mac 真机）**。实现已按「它会骗人」处理——**故意丢弃返回值**，成功判据只用「回读前台 pid」（`app/electron/inject/mac.js` 的 `msgSendBoolUPtr` 注释）。真机仍需确认两件事：① 它到底能不能把目标应用置前；② 若不能，是否改用 `activateFromApplication:options:`。
   **结论（2026-09-16）**：**已验 —— 能置前，不需要改用 `activateFromApplication:options:`。** 2026-09-15 首轮暴露的「置前后目标应用拿不到焦点」**不是这个方法失败**，而是我们自己的悬浮条占着 key window + 「关条 / 还键盘」次序颠倒（见第 7 条与 PRD §5.6 的 2026-09-15 更正）。两处修正后，2026-09-16 在打包版里 2.3 / 3.1 / 3.2 与「采纳后光标留在目标」全过。**「丢弃返回值、只回读前台 pid」这个处理保留** —— 它仍是成功判据的唯一来源。
6. **`objc_msgSend` 经 koffi 的脆弱度** —— 若不可用，走 §4.2 的 `open -b` 退路。
   **结论（2026-09-13）**：**未验（需 Mac 真机）**。macOS 实现自写出后**从未执行过**，以下全部待验：五个 `objc_msgSend` 声明（`msgSendPtr` / `msgSendI32` / `msgSendCStr` / `msgSendPtrI32` / `msgSendBoolUPtr`）的形状正确性；`AXIsProcessTrusted` 能否从 ApplicationServices umbrella framework 解析出符号（符号实际在 HIServices）；`frontPid()` 是否返回真实前台 pid；`pid === process.pid` 自守的前提（`frontmostApplication` 报的是我们主进程 pid）是否成立；`CGEventPost` 在授权后是否真的粘贴一次。全部通过前不得启用 `open -b` 退路，也不得改本决策。
   **结论（2026-09-16）**：**已验 —— 五个签名与 `AXIsProcessTrusted` 符号解析全部可用，`open -b` 退路不需要启用；本决策不变。** 2026-09-15（控制台启动）首次真机执行，2026-09-16 在打包版复验：`koffi` 能加载并调用（`VP_INJECT_SELFTEST=1` 得 24/24）；`frontPid()` 返回真实前台 pid、`pid === process.pid` 自守成立；`CGEventPost` / `CGEventPostToPid` 在授权后确实完成粘贴（用例 2 的应用矩阵）。哪条分支实际命中，可用 `VP_INJECT_DEBUG=1` 的「置前 / 置前后 / 发键: pid=…」日志核对。
7. 置前与发键之间的间隔在各平台上定稿（Windows 60ms / macOS 120ms 是起点，不是承诺）。
   **结论（2026-09-13，Windows 真机）**：**激活本身不是失败点** —— 实测前台到位约 **13–48ms**（远小于等待值），调大/调小 `ACTIVATE_WAIT_MS` 都不是关键旋钮。真正的失败是**我们自己的悬浮条拆条动作扰动掉了目标的激活/键盘焦点**，与这个间隔无关。修法已落地：置前目标**之前**先交出悬浮条的可聚焦性 —— 拆条时那次 `setFocusable(false)` 因此成为空操作（`emit` 看到值未变即整段跳过），扰动源被**结构性消除**。
   **曾短暂加过一段 settle 延时（默认 250ms）**，依据是「不等 = 0/4，等 200ms = 4/4」的真机对照；但那次对照早于上述修法落地，而修法已让延时想防的那个扰动不再可能发生。`VP_ADOPT_SETTLE_MS=0` 复测 **4/4 成功、光标仍留在目标**，故**该延时已删除**（不留没有依据的魔数）。若将来某台机器再现「粘贴丢失」，先怀疑拆条里剩下的动作（`resetBarHeight` 的尺寸复位、渲染层 unmount），而不是先把等待加回来。
   ⚠️ **这两处现在是承重的设计，不再是实现细节**：去掉任一处，真机上会分别出现「粘贴作废」或「粘贴成功但光标回不到目标」。
   ⚠️ 上面那组量化对照**只在 Windows 测过**（13–48ms）。**macOS 已于 2026-09-16 在打包版验过功能成立**（2.3 / 3.1 / 3.2 与「采纳后光标留在目标」全过），但 macOS 的等待值**没有单独做过对照组** ⇒ **不要拿 Windows 的数字去调 macOS 的 `ACTIVATE_WAIT_MS`**；真在 macOS 上复现「粘贴丢失」，先查那两处承重设计和 `[采纳] 拆条两帧…` 告警。
8. 各失败 `reason` 对应的中文文案（三语齐全，走 `app/shared/i18n/*`）。
   **结论（2026-09-13）**：**已实测（Windows 开发机，自动化）**。5 个 `reason` 的三语文案已落在 `app/shared/i18n/{zh-CN,zh-TW,en-US}.js`，i18n 三语键齐自测通过；渲染层用显式映射（`app/src/App.tsx` 的 `ADOPT_FAIL_TEXT`）而不是拼 key，`permission` / `stale` 有独立文案，界面自测锁定了 zh-CN 原文。⚠️ **2026-09-16 更新**：`permission` 已在 runbook 用例 1 的未授权路径真机触发（打包版，提示与文案如预期、深链可跳转、授权后无需重启即生效）。**其余 `reason`（`no-target` / `activate-failed` / `send-failed` / `stale`）仍未逐个单独制造过**，失败归类的完整正确性留待需要时补。
