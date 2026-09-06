# M4 剩余项设计（自定义预设 / 本地历史 / 首次引导 / 悬浮条换亮色）

- **日期**: 2026-09-06
- **状态**: 待评审
- **上游**: `docs/plans/2026-09-05-voicepilot-prd.md`（PRD v1.3）、`docs/superpowers/specs/2026-09-06-main-app-design.md`（主应用骨架与润色工作区，已落地）
- **范围**: 本次只做 M4 的剩余四项——自定义预设（F5 部分）、本地历史（F6）、首次使用引导（F8）、悬浮条换亮色。**设置视图（F7）不在本期**（PRD 里程碑表未把 F7 归入 M4）。

## 0. 本设计已拍板的关键决策

| 决策 | 结论 | 依据 |
|---|---|---|
| 存储方案 | 单库 `node:sqlite`（Node 内建，同步 `DatabaseSync`），文件在 `app.getPath('userData')/voicepilot.db` | 已验证 Electron 44 内置 Node 24.20.0，`node:sqlite` 与 FTS5 trigram 均可用，无需 `better-sqlite3` 原生模块与 electron-rebuild |
| 历史搜索 | **本期只浏览不搜索**，全文搜索推迟 | 用户拍板 |
| 首次引导 | 只记选择、设场景默认值，**ASR 词表位置留空**（内部专名表要等 M6 错误样本产出，届时经 F11 下发） | 用户拍板 |
| 自定义预设 | 预设 = `{name, description}`；内置 4+4 允许改名/编辑说明、**不可删除**；用户新建的可删 | 用户确认 |
| 首次引导形态 | 独立小窗（`#onboarding` 路由），不复用主应用窗口 | 用户确认 |
| 悬浮条换亮色 | 纯视觉换成亮色，**不做主题切换** | 用户确认 |

## 1. 数据模型

单库 `userData/voicepilot.db`，三张表。主进程是唯一读写方，渲染进程永不接触 DB。

```sql
CREATE TABLE IF NOT EXISTS history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  text        TEXT NOT NULL,          -- 原文（含段落换行）
  polished    TEXT,                   -- 润色后文本，用户「采用」后才写
  scene       TEXT,                   -- 润色时场景名（快照字符串，非 id）
  tone        TEXT,                   -- 润色时语气名（快照字符串，非 id）
  duration_ms INTEGER,                -- 音频时长；拿不到为 NULL
  created_at  INTEGER NOT NULL        -- epoch ms
);

CREATE TABLE IF NOT EXISTS presets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK(kind IN ('scene','tone')),
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_builtin  INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(kind, name)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                 -- JSON 字符串
);
```

- **首次建库播种内置预设**：`kind='scene'` 的 邮件/即时通讯/文档/社媒，`kind='tone'` 的 正式/口语/简洁/热情，`is_builtin=1`、`description=''`（用户可编辑补说明）、`sort_order` 递增。
- **`scene`/`tone` 存名字快照而非 id**：历史是「当时用了什么」的记录，预设被删/改名不影响历史条目。
- **`meta` 键**：`first_run_done`（'true'/'false'）、`profession`（'general' | 'product_rd' | 'other'）、`default_scene`（场景默认值）。
- 现有 `llm/prompt.js` 里的硬编码 `SCENES`/`TONES` 常量**退役**，预设统一从 DB 读。

## 2. 本地历史（F6）

### 2.1 写入时机与数据流

机器代码的既有约束：**文本归渲染进程所有**（主进程状态机只转发 `vp:asr/partial`，不存文本）。据此：

- **原文写入**：悬浮条进入 `reviewing`（无论正常停止 / 收尾超时 / 出错收敛，见 PRD §4.3「结果自动写入，无论是否复制」）时，渲染进程调 `vp:history/save({ text })`。**每次会话只存一次**（渲染进程用 ref 标志，下次 `warming` 重置，避免重复入列）。
- **润色后文本写入**：用户在润色工作区点「采用」时，渲染进程调 `vp:polish/adopt({ polished, scene, tone })`，主进程把该次会话对应的历史条目更新 `polished` / `scene` / `tone`。**不采用不写**（原文始终权威，符合 PRD §4.4「显式采用才替换」）。
- **会话↔历史关联**：`vp:history/save` 返回新条目 `id`，渲染进程存 ref；点「润色」时经 `vp:studio/open({ text, historyId })` 传给主进程（主进程记 `pendingHistoryId`）；「采用」时按 `pendingHistoryId` 更新。**无 historyId**（从托盘打开主应用、或手动编辑文本后润色）则「采用」只改本地 state，不回写历史。
- **`duration_ms`**：由主进程从状态机 timing 取得——在 `LatencyMetrics.finish()` 摘要里新增 `dictationDurationMs`（`#stopAt - #toggleAt`），机器在 `#toReviewing()` 时读取并暂存为 `lastDurationMs`，供 `vp:history/save` 落库；两者任一为 null 则存 NULL。
- 每条历史保存时，主进程打印一行日志（与现有 `[延迟]` 落盘风格一致）。

### 2.2 浏览（先只浏览不搜索）

- 历史 tab 列出条目，倒序（最新在前）。每条显示：时间、原文前若干字、场景/语气标签（有 `polished` 则另加「已润色」标记）。
- 点开某条看全文；可「复制」（复用 `vp:copy`）、可「润色」（把该条原文带回润色工作区，等同从悬浮条点润色）。
- 删除历史不在本期范围。

## 3. 自定义预设（F5 部分）

- 预设 = `{name, description}`，存 `presets` 表。
- **内置**（`is_builtin=1`）：可改名、可编辑 description，**不可删除**（避免把默认体验删没）。
- **用户新建**：可新建、可改名、可编辑 description、可删除。
- **润色 prompt**：`场景：{name}（{description}）` 内联；`description` 为空则只内联 `name`。`buildPolishMessages(text, scene, tone)` 改为接收 `{name, description}`（或主进程查 DB 补全 description）。
- **`vp:studio/sync` 改为从 DB 读预设**（带 name+description），替代硬编码常量。
- 新增 IPC：`vp:preset/save`（新建与编辑合一，按有无 id 区分）、`vp:preset/delete`。
- **编辑入口**：润色工作区场景/语气下拉旁加「管理预设」按钮，弹一个轻量模态框做 CRUD（列出当前 kind 的预设，内置条目删除按钮禁用）。

## 4. 首次使用引导（F8）

- **触发**：启动时查 `meta.first_run_done`，为 false 则弹独立小窗。只弹一次，之后 `first_run_done='true'`。
- **窗口**：`#onboarding` 路由的独立小窗（复用现有 `createDiagWindow` 的二级窗口模式，新增 `createOnboardingWindow`）。
- **内容**：只问一个问题「工作主要涉及哪个领域」→ `通用`（默认，可跳过）/ `产品与研发` / `其他`。
- **落盘**：`profession` + `default_scene`（`产品与研发`→「文档」，其余→「邮件」）+ `first_run_done=true`。
- **ASR 词表留空**：本次只记录选择，不加载任何词表；词表能力等 F11 下发后再接。
- 新增 IPC：`vp:meta/get`（启动时查 `first_run_done`/`profession`/`default_scene`）、`vp:onboarding/save({ profession })`。

## 5. 悬浮条换亮色

- 纯视觉：`app/src/App.tsx` 的暗色样式整套换成亮色——近白底、深字，badge/notice/warn/error/draft/hint 颜色对应调整。**不做主题切换**。
- 窗口层不动：`createBar()` 是 `transparent:true`，背景由渲染层 CSS 提供。

## 6. 模块与文件

### 主进程

| 文件 | 动作 | 内容 |
|---|---|---|
| `app/electron/store.js` | 新建 | DB 打开/建表/播种；`history`、`presets`、`meta` 三组 CRUD |
| `app/electron/onboarding.js` | 新建 | `createOnboardingWindow({ attachDevLogging })` |
| `app/electron/main.js` | 改 | 启动时打开 store、查 `first_run_done` 决定是否弹引导窗 |
| `app/electron/ipc.js` | 改 | 新增 history/save、history/list、history/get、preset/save、preset/delete、onboarding/save、meta/get、polish/adopt；`vp:studio/open` 接受 `{text, historyId}`；`vp:studio/sync` 从 DB 读预设 |
| `app/electron/machine.js` | 改 | 暴露本次会话 `lastDurationMs`（`#toReviewing()` 时从 metrics 读取） |
| `app/electron/telemetry/metrics.js` | 改 | `finish()` 摘要新增 `dictationDurationMs`（`#stopAt - #toggleAt`） |
| `app/electron/llm/prompt.js` | 改 | `buildPolishMessages` 支持 `{name, description}`；移除 `SCENES`/`TONES` |
| `app/electron/preload.cjs` | 改 | 暴露新桥接方法 |
| `app/electron/selftest/*` | 改 | 新增 store 自测（建库/播种/历史读写/预设 CRUD） |

### 渲染进程

| 文件 | 动作 | 内容 |
|---|---|---|
| `app/src/studio/HistoryView.tsx` | 新建 | 历史浏览列表 + 详情 |
| `app/src/studio/PresetManager.tsx` | 新建 | 预设 CRUD 模态框 |
| `app/src/onboarding/Onboarding.tsx` | 新建 | 首次引导页 |
| `app/src/studio/Studio.tsx` | 改 | 接入 HistoryView（替换「待实现」占位） |
| `app/src/studio/PolishView.tsx` | 改 | 「管理预设」入口、采用时调 `vp:polish/adopt`、场景/语气从 DB（带 description） |
| `app/src/main.tsx` | 改 | `#onboarding` 路由 |
| `app/src/App.tsx` | 改 | 换亮色；`reviewing` 时存历史；`vp:studio/open` 传 `historyId` |
| `app/src/global.d.ts` | 改 | 新桥接方法类型 |
| `app/src/uitest/run.tsx` | 改 | 界面自测补历史/预设/引导断言 |

## 7. 测试策略

沿用现有两种自测模式（见主应用实现计划）：

1. **主进程自测**（`VP_STORE_SELFTEST=1`）：不建窗口，验 store 真实路径——建库/播种内置预设、历史写入与读取、预设增删改、meta 读写。跑完退出。
2. **界面自测**（`VP_UI_SELFTEST=1`）：假 bridge 注入，断言历史列表渲染、预设模态框增删、引导页选择后回调、润色采用后 `adopt` 被调。

## 8. 范围外（本设计不做）

- 设置视图（F7：快捷键可配置+冲突检测、触发模式、开机启动、职业/词表管理）
- 历史全文搜索（FTS5，已确认本期的 DB 绑定可直接加 `CREATE VIRTUAL TABLE ... fts5(trigram)`，留待下期）
- 历史条目删除
- ASR 词表加载能力（等 F11）
- 主题切换（悬浮条只做一次性换亮色）
- macOS 托盘 template 图标（等 Mac 到位）

## 9. 验收对齐

- **A9**（历史可回看、重启后仍在）：本期覆盖「回看 + 持久化」；「可搜索」留待下期，A9 阶段性部分满足，需在验收时标注。
