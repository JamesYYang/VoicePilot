# VoicePilot 闻字

> **出口成章** · 说话即成文的桌面语音输入工具

全局快捷键触发，边说话文字边实时上屏；说完一键复制到任意应用，或展开成主应用做润色、调整场景与语气。

> **当前状态**：桌面端（Windows）主链路与主应用已可用，正朝公司内部 50+ 人试用推进。macOS 适配与内部试用基建仍在路上。
> 产品权威文档见 [`docs/plans/2026-09-05-voicepilot-prd.md`](docs/plans/2026-09-05-voicepilot-prd.md)。

---

## 它是什么

一个常驻托盘的桌面语音输入工具，有两个形态：

| | 悬浮条（Mini） | 主应用（Studio） |
|---|---|---|
| 触发 | 全局快捷键 | 悬浮条点「润色」 |
| 位置 | 桌面右下角，半透明，置顶，**不抢焦点** | 普通应用窗口 |
| 职责 | 实时听写 + 复制 + 润色入口 | 润色、场景×语气、历史回看 |

核心流程：**快捷键 → 说话（灰字实时跟随，停顿定稿转白字）→ 停止 → 复制 / 润色**。

**明确的边界**：

- **不是输入法**：不接管键盘、不在光标处直接插字。v1 的输出终点是**剪贴板**（复制后自己粘贴），注入光标推迟到后续阶段。
- **不是会议转写工具**：v1 只处理一个人的麦克风输入，会议记录是后续方向。
- **不是云服务**：音频只在识别过程中上传，不留存；文本只存本地。

---

## 想解决什么

现有语音输入基本是「录音 → 转写 → 得到一段文字」，写作时真正想要的是**说话的时候文字已经在长出来**。VoicePilot 要做的是：

1. **边说边出字**，不是说完一段等结果。
2. **自动收敛成文**：正在说的是灰色草稿，停顿后定稿成白字——「出口成章」的核心机制。
3. **说完成稿即用**：结果进剪贴板，可直接粘贴，或按场景/语气润色后使用。

---

## 当前进展

| 里程碑 | 状态 |
|---|---|
| M1 采集 spike（Windows） | ✅ 输出字节率合格、无时钟漂移 |
| M2 主链路（Windows）：快捷键 → 采集 → ASR → 悬浮条 → 复制 | ✅ 完成，自测全绿 |
| M4 主应用：润色、场景×语气、自定义预设、本地历史、首次引导 | ✅ 完成 |
| M3 macOS 适配 + 分发（不抢焦点、权限引导、签名公证） | ⏸ 等 Mac 到位 |
| M5 内部试用基建（遥测、诊断导出、自动更新、配置下发） | ⏸ 未开始 |
| M6 内部试用运行期（50+ 人使用，收集反馈与错误样本） | ⏸ 未开始 |

延迟预算与实测数据、验收标准详见 PRD §6 / §7 / §8。

---

## 技术栈

- **桌面壳**：Electron 44 + React 19 + TypeScript + Vite（UI 与框架解耦，将来可迁移 Tauri）
- **ASR**：阿里云百炼 `qwen-audio-3.0-asr-flash-streaming`（实时 WebSocket，灰字→白字两态）
- **润色 LLM**：百炼 `deepseek-v4-pro-0813`（流式，与 ASR 共用一把 Key）
- **本地存储**：Node 内建 `node:sqlite`（SQLite，历史 / 预设 / 设置，零原生依赖）

---

## 快速开始

### 1. 配置凭证

```bash
cp .env.example .env
```

在仓库根 `.env` 里填两个值（都在[百炼控制台](https://bailian.console.aliyun.com/)获取）：

- `DASHSCOPE_API_KEY` — API Key
- `DASHSCOPE_WORKSPACE_ID` — **业务空间 ID**（不是 API Key，两个都要）

> Key 只存在主进程，渲染进程拿不到。当前是**开发期从 `.env` 读取**；正式分发时改为配置端点下发（PRD §5.8 / F11，M5）。

### 2. 跑桌面应用

```bash
cd app
npm install
npm start          # vite build && electron .
```

默认快捷键：Windows `Ctrl+Shift+Space`（macOS `⌥Space`，尚未适配）。在悬浮条上说话、停止后「复制」或「润色」。

### 自测

```bash
cd app
npx tsc --noEmit                          # 全量类型检查
VP_UI_SELFTEST=1 npx electron .           # 界面自测（隐藏窗口 + 假 bridge）
VP_STORE_SELFTEST=1 npx electron .        # 存储自测
VP_SM_SELFTEST=1 npx electron .           # 状态机自测
```

---

## 项目结构

```
├── app/                      桌面端（Electron + React + TS）
│   ├── electron/             主进程（纯 ESM .js）：窗口/托盘/快捷键/状态机/ASR/润色/存储
│   ├── src/                  渲染进程（TSX）：悬浮条、主应用（润色/历史）、引导、诊断
│   ├── build/                图标等构建资源
│   └── dist/                 渲染产物（vite 输出，gitignore）
├── spike/                    测量与验证工具（延迟/准确率探针、并发压测、音频转码）
├── demo/                     早期浏览器原型（历史产物，已由桌面端取代）
└── docs/
    ├── plans/                PRD 与早期设计文档
    └── superpowers/          specs 与实现计划
```

`spike/` 是验证工具链，不是产品代码。它负责回答「延迟达不达标、准确率多少、并发上限多少」这类问题，支撑 PRD 里的数据。

---

## 设计文档

- **PRD（权威）**：[`docs/plans/2026-09-05-voicepilot-prd.md`](docs/plans/2026-09-05-voicepilot-prd.md)
- **主应用设计**：[`docs/superpowers/specs/2026-09-06-main-app-design.md`](docs/superpowers/specs/2026-09-06-main-app-design.md)
- **M4 剩余项设计**：[`docs/superpowers/specs/2026-09-06-m4-remaining-design.md`](docs/superpowers/specs/2026-09-06-m4-remaining-design.md)
- **ASR 实测结论与踩坑**：[`docs/plans/2026-08-31-engine-mvp-design.md`](docs/plans/2026-08-31-engine-mvp-design.md)

---

## 已知限制 / 下一步

- **macOS 未适配**：M1 的 macOS 半与整个 M3（不抢焦点、权限引导、签名公证）仍等 Mac 到位。
- **注入光标未做**：v1 输出终点是剪贴板，注入其他应用推迟到后续阶段。
- **历史搜索未做**：当前历史只支持浏览，全文搜索（FTS5）属下一批。
- **设置界面未做**：快捷键可配置、触发模式、开机启动、职业/词表管理（F7）待开发。
- **准确率无 ground truth**：字准确率验收依赖内部试用期的错误标记数据（M6）。
