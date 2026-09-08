# 移除「职业」维度设计（欢迎页 + last-used 默认场景）

- **日期**: 2026-09-08
- **状态**: 待评审
- **上游**: `docs/plans/2026-09-05-voicepilot-prd.md`（PRD v1.4）、`docs/superpowers/specs/2026-09-06-m4-remaining-design.md`（F8 首次引导已落地但暂缓启用）
- **范围**: 移除「职业」维度——F8 选职业、`职业 → default_scene` 映射、以及隐含的「职业 → ASR 词表」设计，替换为「欢迎页 + last-used 默认场景」。ASR 词表本期本就留空，无代码变更，仅同步 PRD 描述。

## 0. 已拍板的关键决策

| 决策 | 结论 | 依据 |
|---|---|---|
| 职业维度 | **整体移除** | ASR 层「按职业切词表」是伪需求（内部专名表全体共享、内容数据驱动，与用户自报职业无关）；润色层「职业→默认场景」价值≈省一次下拉，用 last-used 即可覆盖 |
| F8 首次引导 | 选职业 → **欢迎页**（欢迎语 + 快捷键说明 + 麦克风权限提示 + 「开始使用」按钮） | 用户拍板 |
| 欢迎页时机 | **默认启用，首次启动弹一次**，之后不再弹 | 用户拍板 |
| `default_scene` | **last-used**：点「润色」时记录当前场景；首次无记录默认「文档」 | 用户拍板 |
| ASR 词表 | 本期留空不变；M6 起共享专名表经 F11 默认下发 | PRD §5.3 既定路径 |
| `VP_ENABLE_ONBOARDING` | 删除 | 暂缓理由（职业→两组提示词未定）已消失 |

## 1. 欢迎页（F8 重写）

### 1.1 内容

单页，无提问：

1. 欢迎语（一句话）
2. 全局快捷键说明——按平台显示：Windows 为触发键，macOS 为 `⌥Space`
3. 麦克风权限提示——首次使用需在系统设置授予；macOS 另提全局快捷键所需的「辅助功能」权限
4. 「开始使用」按钮

### 1.2 时机与标记

- 复用现有 `meta.first_run_done` 键作「已看过」标记，不新增键。
- 主进程启动时：`getMeta('first_run_done') !== 'true'` 即弹窗（删除 `VP_ENABLE_ONBOARDING === '1'` 条件）。
- 写标记：在 `onboarding.js` 的 `win.on('closed')` 里 `setMeta('first_run_done', 'true')`，**无论「开始使用」还是点 X 关闭都算看过**，避免重复弹窗烦人。
- 「开始使用」按钮复用现有 `closeOnboarding`（`vp:onboarding/close`）关窗即可，不需要新 IPC 来写标记（标记在 `closed` 事件统一写）。

## 2. `default_scene` → last-used

### 2.1 数据流

```
用户点「润色」 → vp:polish/start {text, scene, tone}
              → ipc.js handler: setMeta('default_scene', scene.name)   ← 新增一行
              → streamPolish(...)
下次打开润色工作区 → syncStudio → defaultScene: getMeta('default_scene')   ← 已存在，不变
```

- **写入方**：`ipc.js` 的 `vp:polish/start` handler 里加一行 `setMeta('default_scene', scene?.name ?? '')`。渲染层 `PolishView` 零改动。
- **读取方**：`syncStudio` 的 `defaultScene` 逻辑不变（`ipc.js:160` 已读 `meta.default_scene`）。
- **首次无记录**：渲染层 `PolishView` 现有逻辑是「找不到匹配的 scene 名则回退 `scenes[0]`」，已能兜底。首次默认值由「文档」落在 `scenes` 首项实现——**调整 `BUILTIN_SCENES` 顺序把「文档」放第一**（现为 `['邮件','即时通讯','文档','社媒']` → `['文档','邮件','即时通讯','社媒']`），这样无记录时自然默认「文档」，无需额外分支。

### 2.2 与旧映射的关系

- 删除 `ipc.js:228-229` 的 `setMeta('profession', ...)` 与 `setMeta('default_scene', profession === 'product_rd' ? '文档' : '邮件')`。
- `meta.profession` 键自然废弃（不再写入；已存在的旧值无人读，无害，不迁移）。

## 3. 代码改动清单

| 文件 | 改动 |
|---|---|
| `app/src/onboarding/Onboarding.tsx` | 三档职业按钮 → 欢迎页（欢迎语 + 快捷键 + 权限提示 + 「开始使用」按钮，调 `closeOnboarding`） |
| `app/electron/onboarding.js` | 窗口尺寸/标题适配欢迎页；`win.on('closed')` 里加 `setMeta('first_run_done', 'true')` |
| `app/electron/ipc.js` | 删 `vp:onboarding/save` handler；`vp:polish/start` handler 加 `setMeta('default_scene', scene?.name ?? '')` |
| `app/electron/preload.cjs` | 删 `saveOnboarding`；保留 `closeOnboarding` |
| `app/src/global.d.ts` | 删 `saveOnboarding` 接口 |
| `app/electron/main.js` | 启动触发条件删 `VP_ENABLE_ONBOARDING === '1'`，改为 `getMeta('first_run_done') !== 'true'`；删除注释里的「暂缓启用」说明 |
| `app/electron/store.js` | `BUILTIN_SCENES` 顺序：文档 → 邮件 → 即时通讯 → 社媒（让首次默认「文档」） |
| `app/src/studio/PolishView.tsx` | 无改动（last-used 写入在主进程完成） |
| `app/electron/selftest/store.js`、`app/src/uitest/run.tsx` | 删除对 `saveOnboarding`/`profession` 的断言与 mock；补 `first_run_done` 经 `closed` 写入、`default_scene` 经 `polish/start` 写入的断言 |

## 4. 数据模型

无 schema 变更。`meta` 表键的变化：

| 键 | 变化 |
|---|---|
| `first_run_done` | 保留，语义不变（欢迎页看过标记） |
| `profession` | 废弃，不再写入 |
| `default_scene` | 保留，语义从「职业映射结果」改为「上次润色使用的场景」 |

## 5. PRD 更新

- §4.0 F8：从「选职业 → 设场景默认值」改为「欢迎页（快捷键 + 权限提示）」；删除「职业同时驱动 ASR 层与润色层」的表述。
- §5.3：删除「职业 → 领域词表」的绑定，改为「共享专名表默认加载（M6 起，经 F11 下发）」；「产品与研发/其他」的职业分层描述同步删除。
- §9 开放问题：将「职业 → 两组提示词」标记为**已放弃**（理由：ASR 层按职业切词表是伪需求，润色层用 last-used 覆盖）。

## 6. 测试

- **store 自测**（`selftest/store.js`）：更新断言——`first_run_done` 写入/读取不变；新增 `default_scene` 可由 `polish/start` 写入。
- **UI 自测**（`uitest/run.tsx`）：移除 onboarding 职业选择相关用例；新增欢迎页「开始使用」按钮存在性、点击后触发 `closeOnboarding` 的用例。
- **手工验证**：`npm start` 首次启动弹欢迎页 → 点「开始使用」关窗 → 二次启动不再弹；润色工作区选「邮件」→ 点「润色」→ 重开主应用默认场景为「邮件」。

## 7. 错误处理

本设计几乎无新错误路径（`setMeta`/`getMeta` 为既有同步 SQLite 读写）。唯一注意点：`vp:polish/start` 里 `setMeta` 应放在 `streamPolish` 之前、且不阻塞主流程——即使写入失败也不影响润色本身（`setMeta` 抛错由外层 `try/catch` 统一归入「润色失败」提示即可，但更稳妥的做法是包一层独立 try 避免 meta 写失败污染润色结果）。实现时按后者处理。
