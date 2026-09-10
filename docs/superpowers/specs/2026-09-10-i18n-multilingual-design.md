# 多语言（i18n）全链路设计

日期：2026-09-10
状态：已与用户逐项确认

## 背景与目标

产品当前界面文案全部硬编码中文，无任何 i18n 基础设施。用户公司有中国人（简中）、台湾人（繁中）、美国人（英文）三类使用者，需要：

1. UI 界面文字多语言，用户可在设置页切换，默认跟随系统语言，切换即时生效。
2. 语音识别正文与润色输出正确匹配语言与繁简。
3. 内置「场景/语气」词表本地化。

范围：**全链路**（UI + 润色输出语言 + 词表），非纯 UI。

## 已确认决策

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 范围 | C 全链路：UI + 润色输出 + 词表本地化 |
| 2 | 语言清单 | zh-CN / zh-TW / en-US |
| 3 | 默认语言 | 跟随系统语言（`app.getLocale()` 映射） |
| 4 | 语言选择器 | 设置页（SettingsView）三选一 |
| 5 | 词表本地化 | 同一组概念三语显示名 + 自定义预设带语言标记 |
| 6 | default_scene | 从存 name 改为存 id |
| 7 | 繁体输出 | OpenCC 简→繁后处理（百炼不支持繁体参数，见下） |
| 8 | 润色输出语言 | 跟随输入语种，繁简跟界面语言走 |
| 9 | 语言切换 | 即时生效 |
| 10 | 产品名 | VoicePilot 主名 + 中文副名（简「闻字」/繁「聞字」） |
| 11 | 技术选型 | 轻量自建字典（非 react-i18next / react-intl） |

## 外部依赖事实（已核实）

百炼 ASR（`qwen-audio-3.0-asr-flash-streaming`）**不支持繁体输出参数**：
- `language` 参数仅指定「输入音频语种」，用于提升识别准确率，非输出语言控制。
- 无繁简体转换参数，输出文本繁简体「由模型自行决定」（中文基本为简体）。
- 模型支持「港台口音」识别，但口音 ≠ 繁体输出。

结论：繁体必须靠后处理 OpenCC 简→繁，ASR 侧无参数可锁定。

## 架构与目录

**locale 单一真源在主进程。**

新增共享字典模块 `app/shared/i18n/`：

```
shared/i18n/
  index.js      # 三语字典聚合 + t(locale, key, params) + locale 映射/校验
  zh-CN.js
  zh-TW.js
  en-US.js
  index.d.ts    # 渲染进程 TS 类型声明
```

- 字典用 `.js`（ESM）：主进程 node 直接 import；渲染进程 Vite import（Vite root 为 `app/`）。
- 主进程 `store.js` 的 meta 表存 `ui_language`（取值 `zh-CN` / `zh-TW` / `en-US`）。
- 启动时若无 `ui_language`，用 `app.getLocale()` 映射：`zh`→`zh-CN`、`zh-TW`/`zh-HK`→`zh-TW`、`en`→`en-US`、其余→`en-US`。
- 新增 IPC：
  - `vp:lang/get` → 返回当前 locale
  - `vp:lang/set(locale)` → 校验后写 meta + 内存更新 + 广播 + 重建托盘菜单/窗口标题
  - `vp:lang/changed` → 主进程 → 渲染进程广播
- `preload.cjs` 桥接以上通道；`global.d.ts` 补 `voicepilot` 类型。

## 数据流（即时生效）

```
设置页选语言
  → vp:lang/set(locale)
  → 主进程: setMeta('ui_language') + 内存 locale 更新
      + webContents.send('vp:lang/changed', locale) 广播所有窗口
      + 重建托盘菜单 / 更新窗口标题（主进程文案走 t()）
  → 各渲染进程订阅 changed → React Context setLocale → 全组件重渲染
```

各窗口（studio / 悬浮条 / onboarding / key-entry）挂载时 `vp:lang/get` 拉当前 locale 初始化，再订阅 `vp:lang/changed`。

## 关键改动点（6 项）

### 1. UI 文案替换

- 渲染进程 9 个组件：`App.tsx`（悬浮条状态/错误/按钮）、`studio/Studio.tsx`（导航）、`studio/PolishView.tsx`、`studio/HistoryView.tsx`、`studio/PresetManager.tsx`、`studio/SettingsView.tsx`、`onboarding/Onboarding.tsx`、`key-entry/KeyEntry.tsx`。（`diag/DiagPanel.tsx` 属开发工具，暂不 i18n。）
- 主进程：`main.js` 托盘 tooltip/菜单、`studio.js`/`onboarding.js`/`key-entry.js` 窗口标题、`session/machine.js` 错误文案（服务繁忙/连接中断/已重试 X 次）。
- 全部硬编码中文 → `t('key')`。

### 2. OpenCC 简繁转换

- 位置：主进程 `session` 层，ASR 最终文本出来、上屏/润色前。
- 条件：`locale === 'zh-TW'` 时对最终文本做简→繁。
- 依赖：`opencc-js`（纯 JS/WASM，无 native binding，跨平台免编译）。
- 降级：转换失败不阻塞，输出简体原文。

### 3. 润色 prompt 输出语言

- `llm/prompt.js` 注入「输出语言与输入文本一致」指令。
- 繁简由第 2 步保证（输入已是繁体，输出自然繁体）；语种由输入文本自动决定（含中文字符→中文、纯英文→英文）。

### 4. 词表（场景/语气预设）改造

`presets` 表加三语列 + lang 列（不用 name 存 JSON，避免 SQLite JSON 解析与约束失效）：

```
presets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL CHECK(kind IN ('scene','tone')),
  name         TEXT NOT NULL,          -- 内置：zh-CN 名作主键；自定义：用户输入名
  name_zh_cn   TEXT,                    -- 内置预设三语名
  name_zh_tw   TEXT,
  name_en      TEXT,
  description  TEXT NOT NULL DEFAULT '',
  lang         TEXT,                    -- 自定义预设创建时语言；内置为 NULL
  is_builtin   INTEGER NOT NULL DEFAULT 0,
  sort_order   INTEGER NOT NULL DEFAULT 0
)
```

- 内置预设：seed 时写入 `name` + 三列 `name_zh_cn/name_zh_tw/name_en`，`lang = NULL`。
- 自定义预设：只写 `name`（用户输入名）+ `lang`（创建时语言），三列 name_* 为 NULL。
- 渲染进程按当前 locale 取显示名：内置 → 对应 `name_zh_cn/name_zh_tw/name_en`；自定义 → 原样显示 `name`（跨语言不翻译）。
- `default_scene`：从存 `scene.name` 改为存 `scene.id`（`ipc.js:188` 写入处 + 读取处同步改）。
- 旧数据迁移：`default_scene` 若为旧 name 值，按 name 反查 id；查不到则清空。

### 5. 产品名

- 字典加 `productName` 键：zh-CN「VoicePilot 闻字」、zh-TW「VoicePilot 聞字」、en-US「VoicePilot」。
- 托盘 tooltip、各窗口标题、onboarding、权限引导统一走 `t('productName')`。

### 6. 设置页语言选择器

- `SettingsView` 加「语言」区块，三选一，调 `vp:lang/set` 即时生效。

## 词表三语对照

### 场景（scene）

| zh-CN | zh-TW | en-US |
|---|---|---|
| 文档 | 文檔 | Document |
| 邮件 | 郵件 | Email |
| 即时通讯 | 即時通訊 | Instant Messaging |
| 社媒 | 社媒 | Social Media |

### 语气（tone）

| zh-CN | zh-TW | en-US |
|---|---|---|
| 正式 | 正式 | Formal |
| 口语 | 口語 | Casual |
| 简洁 | 簡潔 | Concise |
| 热情 | 熱情 | Warm |

## 边界与降级

- 缺 key：`t()` 返回 key 本身，便于开发时发现遗漏。
- 未知/非三语 locale：统一 fallback `en-US`。
- 系统语言检测失败、meta 值非法：fallback `en-US`。
- OpenCC 转换失败：不阻塞，输出简体原文。
- 旧 `default_scene` 值为 name 时：迁移为按 name 反查 id；查不到则清空。

## 测试策略

- 单元：`t()`、locale 映射、`default_scene` 迁移、OpenCC 转换。
- 组件：三语下各组件渲染（复用现有 `uitest` 机制）。
- 集成：设置页切语言 → 主应用 / 悬浮条 / 托盘同步生效。

## 范围外（本次不做）

- 更多语言（日语等）、运行时懒加载翻译、翻译管理平台接入。
- `diag/DiagPanel.tsx` 诊断界面 i18n。
