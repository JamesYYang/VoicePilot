# 常用语设计（不说话直接选一条采纳）

- **日期**: 2026-09-13
- **状态**: 待评审
- **上游**: `docs/superpowers/specs/2026-09-12-trial-feedback-design.md`（本文件是试用反馈之后新增的第 6 条需求）；`docs/superpowers/specs/2026-09-13-adopt-injection-design.md`（采纳写回是本功能的下游依赖）；`docs/plans/2026-09-05-voicepilot-prd.md`
- **来源**: 2026-09-13 试用反馈第 6 条：「能不能设置常用语，比如用户录入后或者润色后，可以把这个设置到自己的常用语里。下次相同的场景，快捷键唤起后可以不用说话，直接选择自己的常用语，然后采纳，就可以很快地用到当前的书写中。」
- **范围**: 只做「**存一条文本为常用语**」+「**用第二个快捷键唤起选择器，挑一条落进悬浮条，再走既有采纳**」。
  **不含**：占位符/模板变量、常用语与场景/语气的绑定、按场景分组、重复内容去重、跨设备同步、从历史页直接存为常用语。
  以上六项在 §0.1「明确排除」里逐条说明，**不要在 review 里当缺陷重开**。

## 0. 已拍板的关键决策

| 决策 | 结论 | 依据 |
|---|---|---|
| 进入方式 | **独立的第二个全局快捷键**直接开选择器 | 用户拍板 2026-09-13 |
| 是否启动识别 | **不启动**。选择器态不进 `warming`，不起 ASR 会话，不产生识别费用 | 由上一行直接推出（独立快捷键＝不走 `start()`） |
| 选中之后 | **先落进悬浮条的 reviewing 编辑区**，可改可润色，再按「采纳」 | 用户拍板 2026-09-13 |
| 与场景/语气的关系 | **泛指，不绑定**。常用语是纯文本库，采纳时场景/语气就是条底当前选的那套 | 用户拍板 2026-09-13 |
| 保存动作 | **一键存，不打断**。标题自动取文本首行，改名去主应用 | 用户拍板 2026-09-13 |
| 保存入口 | 悬浮条 reviewing 态头部的图标按钮（从听写结果存）。Studio 页也能从零手写新建一条 | 由上一行推出（保存发生在「录入后 / 润色后」，两处都在条内）。注意这与 §0.1 第 5 条排除的「把历史记录提升为常用语」不是同一件事 |
| 管理界面 | **Studio 新增一页「常用语」**，与 润色 / 历史 / 设置 并列 | 用户拍板 2026-09-13 |
| 选择器交互 | **可搜索 + ↑↓ + Enter + Esc**，默认按最近使用优先排序 | 用户拍板 2026-09-13 |
| 实现路线 | **状态机新增第六态 `phrases`**（否决「复用 reviewing + 浮层」与「独立选择器窗口」） | §1.1 |
| 第二快捷键默认值 | **给默认值**（Win `Ctrl+Alt+Space` / Mac `Alt+Shift+Space`），设置页可改 | 用户拍板 2026-09-13 |
| 常用语是否落历史 | **不落历史** | §2.3 |
| 剪贴板 | 沿用上游：**从不还原** | `2026-09-13-adopt-injection-design.md` §0 |

### 0.1 明确排除（不修）

1. **占位符 / 模板变量**（如「您好 {{姓名}}」）。需求原话是「把这个设置到常用语里」，是固定文本，不做变量替换。
2. **常用语与场景/语气绑定、按场景分组**。用户明确选了「泛指，不绑定」。
3. **重复内容去重**。同一条文本可以存多次，允许重复条目。
4. **跨设备同步**。常用语只在本地 `voicepilot.db`。
5. **从历史页直接存为常用语**。需求给的两个入口（录入后、润色后）都在悬浮条内。历史页那条路等有人真的伸手要了再加。
6. **选择器自动关闭**（失焦即关）。鼠标点到别处时选择器保持打开，需要 Esc / 再按一次快捷键 / 选中才关。

> 以上是本次范围的边界，不是缺陷。若将来要扩，先回头改本表，再动实现。

### 0.2 已知代价（不修）

1. **第二快捷键撞键时用户看不到提示**。启动期注册失败只打日志（既有 `applyShortcut` 行为），悬浮条与设置页都不会主动弹提示。逃生口：设置页里重录同一个键会走到既有的「该快捷键已被占用」提示。这是「给默认值」这个选择的直接代价。
2. **选择器的核心交互依赖一条至今零验证的 macOS 行为**（详见 §6 风险 1）。Windows 侧现在就能全验。

## 1. 状态与交互

### 1.1 为什么新增第六态，而不是复用 reviewing

否决的两条路线，理由记在这里免得将来重开：

- **复用 `reviewing` + 浮层**：`reviewing` 一进来就会触发两条既有副作用——把 `fullText` 灌进编辑区（`app/src/App.tsx:315`）、把 `fullText` 写进历史（`app/src/App.tsx:356`）。而 `fullText` 是从 ASR 分片算出来的，常用语根本不走 ASR。要么给这两条副作用加「本次是不是常用语」的分支（等于在渲染层把状态机已有的事实用启发式重造一遍），要么让常用语伪装成 ASR 结果（更糟）。
- **给选择器单开一个 BrowserWindow**：布局最自由，但要复制一遍窗口管线（定位、可聚焦、鼠标穿透、`skipTaskbar`、macOS 的 `type:'panel'`），且「选完落进条里」变成跨窗口交接。为一个选择器付这个成本不值。

新增一态是顺着既有结构长：**「目标窗口的生命周期」与「谁能聚焦」这两件事本来就归状态机管**（`app/electron/session/machine.js:46`、`:149`）。

### 1.2 状态集与第二快捷键的语义

状态集变成 `idle / warming / listening / draining / reviewing / phrases`。第二快捷键（槽位 `phrases`）的按下语义：

| 当前态 | 行为 |
|---|---|
| `idle` | `openPhrases()`：同步捕获目标窗口 → 进 `phrases` |
| `phrases` | `closePhrases()`：关掉选择器 → 回 `idle`（焦点还给原应用，见 §1.4） |
| `warming` / `listening` / `draining` / `reviewing` | **忽略，什么都不做**，返回 `{ ignored: true }` |

忽略那四态是刻意的：前三个正在录音或收尾，切走等于丢掉这段听写；`reviewing` 里已经躺着一段结果，弹选择器会把它顶掉。**宁可「按了没反应」，也不要静默毁掉用户已有的内容。**

**主快捷键（`toggle()`）在 `phrases` 态同样忽略**，落到既有 if 链末尾的 `{ ignored: true }`（`app/electron/session/machine.js:126`）。这里刻意**不做**「关掉选择器并顺势开始听写」——那要在一个按键里串两个状态跃迁，还要重新判断目标窗口是否仍然有效。用户想改用听写，Esc 关掉再按主键，两步、可预期。

### 1.3 焦点——这里相对 reviewing 破一个例

- `isBarFocusable(state)`（`machine.js:46`）从「只有 `reviewing`」扩成「`reviewing` | `phrases`」。仍然只有这两个态允许聚焦，`warming` / `listening` / `draining` / `idle` 一律不可聚焦——A2（不抢焦点）没被削弱。
- **但 `phrases` 态要主动 `focus()`，而 `reviewing` 从不主动 focus**（`app/electron/ipc.js:52` 那条注释是特意写的：「切成可聚焦只是允许用户点击进来」）。
  理由：选择器的全部价值就是键盘驱动（输入筛选 + ↑↓ + Enter）。不主动 focus 就得先拿鼠标点一下搜索框，「快」这个前提当场就没了。
  这个破例是安全的：**用户是主动按了快捷键才进来的**，不存在「被抢焦点」。A2 要防的是「聆听时把用户正在打字的应用的焦点夺走」，这里用户的意图就是要跟悬浮条交互。
- `setFocusable` 会触发 `SWP_FRAMECHANGED`，进而让 shell 重建任务栏按钮、抵消 `skipTaskbar`。既有修法（`emit()` 里成对重申 `setSkipTaskbar(true)`，`app/electron/ipc.js:63`）**走的是同一个 `emit()` 路径，自动覆盖 `phrases` 态**，不需要新代码。

### 1.4 离开时的焦点归还

**统一规则：凡是「我们主动拿走了焦点、现在要回 `idle`」的路径，都把它还给捕获的目标窗口——但只在悬浮条当前确实持有焦点时（`bar.isFocused()`）。** 具体覆盖两条路径：

1. **关掉选择器**（Esc / 再按一次短语快捷键）：`phrases → idle`
2. **关掉「从常用语来的 reviewing」**（「关闭」按钮 / 主快捷键 dismiss）：`reviewing(origin='phrase') → idle`

**选中不在此列**：点到一条常用语是 `phrases → reviewing`，不是回 `idle`。条保持可聚焦、继续持有焦点（用户马上要按「采纳」或改文本），目标窗口也保留。若用户接着按「采纳」，那是既有的采纳路径负责把前台交给目标。

**顺序（两条路径相同）：**

```
0. 先取样闸门：restore = shouldRestoreFocus()   // 必须在第 1 步之前
1. #setState('idle')      // emit 同步生效：setFocusable(false) + setSkipTaskbar(true) + resetBarHeight()
2. this.#target = null
3. if (restore) await #activateTarget(target)   // 把前台还给用户原来的应用
```

**第 0 步的位置同样承重。** 闸门读的是 `bar.isFocused()`，而第 1 步的 `setFocusable(false)` 会让窗口**立刻失焦**（Windows 上 WS_EX_NOACTIVATE 的窗口不能被激活，系统会把焦点移走）。放在第 3 步再读，答案永远是 `false` —— 表现是「焦点归还静默从不发生」，而且单测注入的是固定谓词、查不出来。**必须在动窗口状态之前把事实取下来**，之后用取到的布尔值。

**顺序是安全属性，不是风格问题。** 第 1 步必须先做：`setFocusable(false)` 的 frame change 会扰动前台，若先置前再交可聚焦性，激活会被这一下扰动走——这正是 Plan 2B 真机排障确认过的顺序（`app/electron/ipc.js:205` 的「置前目标之前先交出悬浮条的可聚焦性」）。`#setState` 是同步 emit，所以第 1 步返回时可聚焦性已经交出去了。

第 3 步放在 `resetBarHeight()` 之后也是必要的：Plan 2B 的结论是「拆条动作（尺寸复位、渲染层 unmount）会扰动激活」，所以那些动作必须在置前**之前**全部做完。

**为什么用 `bar.isFocused()` 做闸门，而不是无条件归还**：用户可能在看 reviewing 的时候点开了别的应用。无条件置前会把焦点从他刚切过去的地方硬拽回旧目标，那比不归还更烦人。加这个闸门后，「我们只归还自己刚刚拿走的」。

**为什么听写一路的 reviewing 不做这件事**：那条路的焦点从不是我们拿的（reviewing 态不主动 `focus()`，`app/electron/ipc.js:52`），既有行为保持不变，不引入新风险。

> ⚠️ macOS 的 Nonactivating 面板（`type:'panel'`）在 `isFocused()` 上是否如实报告，**未验**。若它恒报 `false`，后果是「静默不归还」——退化成既有行为，不会更糟。列为 §6 风险 3 的真机验证项。

### 1.5 目标窗口的生命周期

| 时机 | 动作 |
|---|---|
| `openPhrases()` 进 `phrases` **之前** | 同步调 `#captureTarget()` 存进 `#target`。与 `start()`（`machine.js:149`）完全同款——必须在条获得焦点之前，否则前台已经是我们自己 |
| `usePhrase()` 进 `reviewing` | **不清空**。采纳要用 |
| `closePhrases()` | 用完再清（§1.4 的顺序） |
| `#dismiss()` 且 `origin === 'phrase'` | 同 §1.4：先回 `idle`、清 target、再置前归还焦点 |
| `#dismiss()` 且 `origin === 'dictation'` / `#cancel()` | 照旧只清空，不置前 |

**捕获失败不拦截**：`#captureTarget()` 返回 `null` 时照开选择器，采纳再按既有 `no-target` 分支失败提示（`{ok:false, reason:'no-target'}`，文案沿用 `bar.adopt.fail`）。不在打开时拦，免得和设备/权限问题混淆。

### 1.6 选择器态绝不启动采集

渲染进程的采集启停依赖「`snap.state` 是 `warming` 或 `listening`」（`app/src/App.tsx:244`）。`phrases` 不在这个集合里，所以**麦克风不会启动、ASR 会话不会建立、不产生任何识别费用**。这是一条要写进自测的断言。

同时补一处防御：`machine.js` 的 `onAudioFrame`（`:158`）目前只在 `idle` / `reviewing` 早退。要把 `phrases` 也加进早退列表——渲染进程虽然不会发帧，但状态机不该依赖调用方的自觉。

## 2. 数据与 IPC

### 2.1 新表 `phrases`

直接加进 `app/electron/store.js` 的 `SCHEMA`。因为 `initStore()` 每次都 `d.exec(SCHEMA)`，而建表语句是 `CREATE TABLE IF NOT EXISTS`，**旧库会自动长出这张表，不需要写迁移函数**（与 presets 那次必须 `ALTER TABLE` 补列的情况不同）。

```sql
CREATE TABLE IF NOT EXISTS phrases (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,      -- 选择器里那行短标签
  text       TEXT NOT NULL,      -- 正文
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  used_at    INTEGER             -- 最近一次被选中，排序用 COALESCE(used_at, created_at) DESC
);
```

### 2.2 store.js 新增 API

形状照抄 history 那一组：同步、每次先 `openStore()`、写操作返回 `{id}` 或 `changes>0`。

```js
export function savePhrase({ title, text })                    // → { id }
export function listPhrases({ limit = 200, offset = 0 } = {})  // 按 COALESCE(used_at, created_at) DESC
export function updatePhrase(id, { title, text })              // → changes > 0（同时刷新 updated_at）
export function deletePhrase(id)                               // → changes > 0
export function touchPhrase(id)                                // 置 used_at = Date.now()
```

**不做 `getPhrase`**：`listPhrases` 已经把标题与正文都带回来了，管理页选中一条时直接用列表里的数据，不需要再取一次。（与 `history` 那组不同——那边 `listHistory` 也带全文，`getHistory` 是历史遗留。）

### 2.3 快照新增 `origin`（决定「不落历史」怎么判）

`getSnapshot()`（`machine.js:107`）从 `{ state, notice, truncated }` 变成 `{ state, notice, truncated, origin }`，`origin ∈ 'dictation' | 'phrase'`：

- 默认 `'dictation'`；`start()` 里重置为 `'dictation'`；`usePhrase()` 里置 `'phrase'`。
- 渲染层拿它当「要不要写历史」的判据：`origin !== 'dictation'` 时跳过 `app/src/App.tsx:356` 那条落库 effect。

**为什么放状态机而不是在渲染层判 `phraseText != null`**：这就是否决路线 B 的同一条理由——不该把机器已有的事实改写成渲染层的启发式。且放状态机里，SM 自测能直接断言它。

**为什么常用语不落历史**：它不是「这次听写」的产物；反复用同一条常用语会在历史里刷屏，而它自己已经有管理页。

### 2.4 新增的 IPC 通道

命名照抄 `vp:history/*`。

| 通道 | 方向 | 说明 |
|---|---|---|
| `vp:phrases/list` | invoke | `listPhrases({ limit: 200 })` |
| `vp:phrases/save` | invoke | `{title, text}` → `{id}` |
| `vp:phrases/update` | invoke | `{id, title, text}` → boolean |
| `vp:phrases/delete` | invoke | `id` → boolean |
| `vp:phrases/touch` | invoke | `id` → boolean。选中那一刻调用，**不 `await`**（失败只影响排序，不该拖慢或挡住进 `reviewing`） |
| `vp:session/toggle-phrases` | invoke | `machine.openPhrases()`（该方法是 toggle 语义），回 `getSnapshot()` |
| `vp:session/use-phrase` | invoke | `machine.usePhrase()`，回 `getSnapshot()` |

**`use-phrase` 不带文本**：选择器的列表本来就是渲染进程从 `vp:phrases/list` 拿的，选中那条的正文它手里就有；状态机只负责「切到 `reviewing`」这个状态事实。这是沿用既有的「文本归渲染进程所有」原则（`machine.js` 头部注释）。

渲染层的正文存在一个本地 state `phraseText` 里。**生命周期**：选中时置为该条正文；进 `warming` 时清空（与既有的文本重置放同一处，`app/src/App.tsx:269-288`）；回 `idle` 时清空。进 `reviewing` 时编辑区的 seed 从 `phraseText ?? fullText` 取（改 `app/src/App.tsx:315` 那条 effect，依赖数组仍只管 `snap.state`——那条 effect 刻意不含 `fullText` 的注释继续有效）。

### 2.5 顺带关掉一个今天就在的活雷（`vp:polish/adopt`）

**现状是错的。** `app/src/App.tsx:517` 传的是 `id: historyIdRef.current ?? undefined`，而 `app/electron/ipc.js:459` 把「未传 id」判为 Studio 路径并回落到 `pendingHistoryId`。于是**历史落库失败时，采纳的润色结果会被写进 Studio 上一次打开的那条无关记录**——正是 2A 终审抓到的那个 Critical 的残留面（那次修了「首次采纳不落库」，没修「落库失败后写错行」）。

常用语路径必然踩它（`origin='phrase'` 时压根没有历史 id），所以必须先修：

```js
// 渲染进程：保留 null，不再转 undefined
id: historyIdRef.current

// 主进程
const target = id === undefined ? pendingHistoryId : (id == null ? null : Number(id));
```

Studio 继续不传 `id`（保住既有回退），悬浮条传显式 `null` 时**不写库**。

**把这个选择抽成纯函数** `resolvePolishTarget(id, pendingHistoryId)` 并配三条断言（`undefined → pendingHistoryId`、`null → null`、`42 → 42`）。项目里已有把不可见映射抽成纯函数来钉住的先例（`isBarFocusable`、`classifyForeground`），这些调用肉眼看不见、删掉也没测试会红。

### 2.6 第二个快捷键的注册

`app/electron/shortcut.js` 现在用一个模块级 `boundAccel`（`:25`）管单个键。改成**按槽位保存**（`main` / `phrases`）：

- `applyShortcut(machine, accel, slot)`；`boundAccel` 变 `Map<slot, accel>`。
- `boundShortcut()` 保持返回主键的绑定值——既有 shortcut 自测在用，不改它的契约。
- 新增 `defaultPhraseAccel(platform)`：Windows `Ctrl+Alt+Space`，macOS `Alt+Shift+Space`（避开主键 `Ctrl+Shift+Space` / `Alt+Space`，以及 Windows 的 `Alt+Space`＝系统菜单、`Win+Space`＝输入法切换）。
- 三条坑的处置逻辑**全部复用、不重写**：`register` 对非法 accelerator 会**抛异常**而非返回 false；挂起期间 `register` 必然返回 false；重录同一个键会返回 false 但应当视为成功。
- 短语槽位的 handler：`() => { void machine.openPhrases(); }`。
- store 侧加 `getPhraseShortcut() / setPhraseShortcut()`（meta key `phrase_shortcut`），形状照抄 `getShortcut/setShortcut`（`store.js:243-253`）。

### 2.7 选择器关闭时的「置前」原语

`app/electron/inject/index.js` 目前对外只导出 `captureTarget` 与 `pasteTo`；平台模块各自导出 `activate` / `sendPaste`。§1.4 第 3 步要一个「只置前、不发键」的跨平台原语，所以新增：

```ts
/** 与 PasteResult 同一套 reason 词表，去掉只有发键阶段才会出现的 'send-failed'。 */
type ActivateResult =
  | { ok: true }
  | { ok: false; reason: 'no-target' | 'stale' | 'activate-failed' | 'permission' };

/** 只把 target 置前，不发任何按键。失败不抛，返回 ActivateResult。 */
export function activateTarget(target: Target | null): Promise<ActivateResult>;
```

它复用各平台模块已有的 `activate`（`inject/win.js` 与 `inject/mac.js` 都已实现并已被 `pasteTo` 使用），**不新写平台代码**。`pasteWith` 的内部结构可顺势抽出这一步，避免两份激活逻辑。

状态机按既有注入手法注入**两个**东西（与 `captureTarget` 同一个模式）：

```js
// ipc.js 里构造时传入
new SessionMachine({
  emit,
  activateTarget,                                    // 默认取 inject/index.js 的真实现
  shouldRestoreFocus: () => getBar()?.isFocused() ?? false,  // §1.4 的闸门
})
```

闸门必须由外部注入——`bar.isFocused()` 是窗口层的事实，状态机不该知道 `BrowserWindow` 的存在（它现在也只认得「一个返回 Target|null 的函数」）。自测注入假实现即可断言「开关顺序」「target 为 null 时不置前」「闸门为 false 时也不置前」。

## 3. 界面

### 3.1 悬浮条内的选择器（`phrases` 态）

搜索框（进态即自动聚焦）+ 列表。

- 键盘：`↑`/`↓` 移动高亮、`Enter` 选中、`Esc` 关闭。方向键必须 `preventDefault`，否则会带着窗口滚动或移动文本光标。
- 鼠标：hover 高亮 + 点击选中。既有的 `vp.setMousePassthrough(!hovering)` 逻辑（`app/src/App.tsx:398-400`）直接覆盖，不需要新代码。
- 高亮项要 `scrollIntoView({ block: 'nearest' })`，否则键盘选到可视区外时用户看不见。
- 列表项两行：`title` 主行 + 正文首行摘要（次行，截断）。
- 空库 / 无匹配显示占位文案，不显示空列表。
- 高度走既有的高度 effect（`app/src/App.tsx:409-455`），上限仍是 `BAR_MAX_HEIGHT = 620`（`app/electron/main.js:47`）。`resetBarHeight()` 只在 `idle`/`warming` 触发（`app/electron/ipc.js:68`），关掉选择器回 `idle` 时自然复位。
- 测试锚点：`data-testid="phrase-search"` / `"phrase-item"` / `"phrases-empty"`。

### 3.2 悬浮条内的「存为常用语」

reviewing 态**头部行加一个图标按钮**，与「打开应用」并列（`app/src/App.tsx:607-632` 那一带）。放头部而不是底部动作行，是因为那里已经是图标区，多一个不挤压底部的五按钮行。

- 存入的文本 = `effectiveText`（有润色结果存润色结果，否则存手改后的原文）——与「采纳」同一口径（`app/src/App.tsx:469`）。
- 标题 = 正文第一个非空行，超过 **40 个字符**截断并补省略号 `…`。抽成纯函数（如 `derivePhraseTitle(text)`）便于自测断言边界。
- 成功后走既有的 `hint` 机制轻提示；失败也走 `hint` 给一句明确提示（不复用错误气泡，避免把 `errorHold` 的 5 秒停留卷进来）。
- 文本为空时按钮禁用。
- 测试锚点：`data-testid="bar-save-phrase"`。

### 3.3 Studio 新增「常用语」页

`app/src/studio/Studio.tsx` 的 `View` union（`:18`）加 `'phrases'`，`ICONS`（`:21-39`）与 `NAV`（`:51-55`）各加一项，内容 switch（`:72-80`）加分支；新文件 `app/src/studio/PhrasesView.tsx`。

结构对称 `HistoryView.tsx`：左侧列表（标题 + 摘要）+ 右侧详情（标题输入框、正文 textarea、保存、删除）。

**不复用 HistoryView**——那是只读 + 复制/润色，语义不同，硬塞会让两边都变形。

详情面板同时承担「新建」：保存按钮在无选中项时就是新增（同一个 `vp:phrases/save`，只是不带 id）。这比刻意禁止新建更省事，也让手写一条常用语成为可能。

### 3.4 Studio 设置页

复用既有的快捷键录制组件，加第二块「常用语快捷键」，复用 `settings.shortcut.record` / `.recording` / `.reset` / `.conflict` / `.unsupported` 这几条既有文案。

### 3.5 i18n

三语同步（`app/electron/selftest/i18n.js:20-26` 会拦）。新增键：

```
bar.phrases.searchPlaceholder   '搜索常用语'
bar.phrases.empty               '还没有常用语。在结果里点书签图标存一条。'
bar.phrases.noMatch             '没有匹配的常用语'
bar.phrases.open                '常用语'          (图标 aria-label / title)
bar.savePhrase                  '存为常用语'       (图标 aria-label / title)
bar.savedPhrase                 '已存为常用语'
bar.savePhrase.fail             '没能存进常用语'
studio.phrases                  '常用语'          (Studio 导航项)
phrase.title                    '标题'
phrase.text                     '内容'
phrase.listEmpty                '还没有常用语'
phrase.save                     '保存'
phrase.saved                    '已保存'
phrase.delete                   '删除'
phrase.new                      '新建'
settings.phraseShortcut         '常用语快捷键'
settings.phraseShortcut.hint    '按下组合键即可修改唤起常用语的全局快捷键'
```

`zh-TW` / `en-US` 各自对应，键集必须一致。

> **2026-09-13 实现评审后删掉 `phrase.selectHint`。** 初稿列了这个 key（「选中一条常用语查看或编辑」），但 §3.3 定的是「详情面板同时承担新建」——空表单就是新建态，于是「未选中」这个详情态根本不存在，这个 key 从未被渲染。三本字典已同步移除，键集仍一致。

### 3.6 bridge 与类型

`app/electron/preload.cjs` 新增 `phrasesList / phrasesSave / phrasesUpdate / phrasesDelete / phrasesTouch / togglePhrases / usePhrase`；`app/src/global.d.ts` 的 `VoicePilotBridge`（`:37-144`）同步补类型。

## 4. 测试

### 4.1 可自动测

| 自测 | 用例 |
|---|---|
| `app/electron/selftest/machine.js`（`VP_SM_SELFTEST=1`） | `openPhrases` 在**条获得焦点之前**捕获目标（注入假 `captureTarget` 断言调用时机）；非 `idle` 态按短语快捷键被忽略且不改状态；主快捷键在 `phrases` 态也被忽略；`usePhrase` 后 `origin='phrase'` 且 target 保留；`closePhrases` 后 `origin`/target 清空且 `activateTarget` 被调用一次；target 为 `null` 时不调 `activateTarget`；闸门 `shouldRestoreFocus` 返回 false 时不调 `activateTarget`；`#dismiss()` 在 `origin='phrase'` 时置前、在 `origin='dictation'` 时不置前；`start()` 把 `origin` 重置回 `'dictation'`；`onAudioFrame` 在 `phrases` 态不入队 |
| `app/electron/selftest/store.js`（`VP_STORE_SELFTEST=1`） | phrases CRUD；`used_at` 影响排序（`COALESCE` 语义）；**旧库迁移断言**——用 `openStoreWithDb(旧 schema 实例)` 证明 phrases 表被自动建出 |
| `app/electron/selftest/shortcut.js`（`VP_SHORTCUT_SELFTEST=1`） | 短语槽位的注册、冲突（占用时旧键不被注销）、挂起期注册必返回 false、非法 accelerator 抛异常被吞 |
| `app/electron/selftest/polish.js`（`VP_POLISH_SELFTEST=1`） | `resolvePolishTarget` 三条：`undefined → pendingHistoryId`、`null → null`、`42 → 42` |
| `app/src/uitest/run.tsx`（`VP_UI_SELFTEST=1`） | `derivePhraseTitle` 边界（空串 / 单行 / 多行 / 恰好 40 与 41 字符 / 首行全空白）；选择器键盘导航（↑↓ 移动高亮并 preventDefault）、Enter 选中、Esc 关闭、空库/无匹配占位；选中后 `origin='phrase'` 时**不调** `historySave`、而 `origin='dictation'` 时照调；条内「存为常用语」按钮存入的是 `effectiveText` 而不是编辑区原文；Studio 常用语页 CRUD |

**跑界面自测前必须先 `npm run build`**（`npm run build && VP_UI_SELFTEST=1 npx electron .`），否则跑的是 `app/dist/renderer` 里的旧产物——这条既有教训在 i18n 那期已经踩过。

### 4.2 不可自动测，只能真机

- 选择器打开后**是否真的拿到键盘输入**（Windows 与 macOS 各一遍）——见 §6 风险 1。
- 焦点归还：两条路径（关选择器 / 关掉从常用语来的 reviewing）各一遍，确认「先交可聚焦性、再置前」真能把前台还回去，且不触发任务栏按钮回归——见 §6 风险 3。
- 「存为常用语」的头图标在真机上是否与「打开应用」图标**视觉上可区分**（两个都是头部内联 SVG，这是 09-12 那轮加图标时踩过的同类问题）。

## 5. 与既有文档的关系

| 文档 | 改动 |
|---|---|
| 本文件 | 新增 |
| `docs/plans/2026-09-05-voicepilot-prd.md` | **✅ 已完成（2026-09-13，实现区间 `648987a…2c5b193`）**：新增 **F16**「常用语」条目与第二个全局快捷键（版本升至 v1.9）。**F14/F15 已被「翻译」「导出 PDF」占用**，编号绕开 |
| `README.md` | **✅ 已完成（2026-09-13，同一实现区间）**：形态表 / 核心流程 / 默认快捷键 / 已知限制各同步一处，并链到 `docs/common-phrases-test-runbook.md` |
| `docs/superpowers/specs/2026-09-12-trial-feedback-design.md` | ⏳ 待办：落地后在 §1 补第 6 条反馈的落点指针，指向本文件（不在本 Task 的文件清单内） |
| `docs/superpowers/specs/2026-09-13-adopt-injection-design.md` | ⏳ 待办：新增 §2.5 的修复会改动它 §3 的 `adoptPolish` 调用形态（新增显式 `null` 语义），落地时同步（不在本 Task 的文件清单内） |

## 6. 待验证 / 已知风险

1. **macOS 的 `type:'panel'` 能否接受键盘输入（最高风险）。**
   2A 就已标记这条为「最大未知」（`app/electron/main.js:176` 的 Nonactivating 面板）。本功能比 2A 严重得多：2A 里键盘输入是锦上添花（点按钮也能用），**而选择器的全部价值就是键盘**——不 focus、收不到按键，搜索与 ↑↓ 全废，只剩鼠标点。
   **已决定（用户拍板 2026-09-13）：按本设计直接实现，不先做 spike。** Windows 侧现在就能全验；macOS 的可验证性与 Plan 2B 的 macOS 那轮合并执行。
   降级路径（若实测键盘不可用）：选择器退化为纯鼠标点选。**退之前要回到本文件改决策，不要在实现里默默退**。
2. **`focus()` 在 `focusable:false → true` 之后的时序**。既有的 `emit()` 明确不调 `focus()`（`app/electron/ipc.js:52`），这条路径从未被执行过。Windows 上需要确认 `focus()` 确实把键盘焦点给了 webContents；若拿到的是「窗口激活但输入框没焦点」，改为显式 `webContents.focus()` + 搜索框 `autoFocus` 双保险。macOS 见第 1 条。
3. **焦点归还路径在真机上是否成立**（§1.4 的两条路径）。两件事分别确认：
   ① 「先回 idle（交可聚焦性 + 尺寸复位）再置前」这个顺序是否真能把前台还回去且不被扰动。它是从 Plan 2B 的排障结论推出来的（那条针对「采纳后拆条扰动激活」；本场景是「关闭后置前」，同类但不等价）。
   ② 闸门 `bar.isFocused()` 是否如实。macOS 的 Nonactivating 面板若恒报 `false`，后果只是「静默不归还」——退化成既有行为，不会更糟。Windows 侧是成熟行为。
4. **第二快捷键在条已聚焦时是否仍能触发**（用来实现「再按一次关闭」）。全局快捷键通常优先于聚焦窗口，但这是平台行为，要真机确认。
5. **撞键时的静默失败**（§0.2 代价 1）。是否在设置页加一块注册状态显示，**尚未决定**；用户当前选择是不加。
6. **置前失败时的处理：完全静默。** 不提示、不改状态，只写 `console.warn`。理由：用户按 Esc 就是明确要走，此刻弹一句「没能把焦点还回去」是打扰，且他的下一步操作不依赖这个结果。
