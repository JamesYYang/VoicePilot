# VoicePilot 闻字

> **出口成章** · 说话即成文的桌面语音输入工具

全局快捷键触发，边说话文字边实时上屏；说完一键复制到任意应用，或展开成主应用做润色、调整场景与语气。

> **当前状态**：桌面端（Windows）主链路与主应用已可用，正朝公司内部 50+ 人试用推进。macOS 已能打包运行（托盘图标 / 不抢焦点 / 公司内网证书三个打包后才暴露的问题已修并复验），剩辅助功能授权复验与签名公证；内部试用基建仍在路上。
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
| M4 主应用：润色、场景×语气、自定义预设、本地历史 | ✅ 完成 |
| M3 macOS 适配 + 分发 | 🔄 已能打包运行；托盘 / 不抢焦点 / 公司内网证书已修并复验，剩辅助功能授权复验、签名公证、dmg 分发 |
| M5-A 试用就绪：Key 下发、设置（快捷键可配 + 开机启动）、诊断导出、F12 按打包 .app 复验 | ⏸ 未开始（下一个动手项） |
| M5-B 规模化基建：遥测与错误标记、自动更新、配置下发其余 | ⏸ 未开始 |
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

> Key 只存在主进程，渲染进程拿不到。**开发期**从 `.env` 读取；**打包版**启动时若没有 Key 会弹窗让用户输入，经 `safeStorage`（Windows DPAPI / macOS Keychain）加密存本机。将来 F11 配置端点下发后，弹窗自动不再出现。

### 2. 跑桌面应用

```bash
cd app
npm install
npm start          # vite build && electron .
```

默认快捷键：Windows `Ctrl+Shift+Space`，macOS `⌥Space`（macOS 需在「系统设置 → 隐私与安全性 → 辅助功能」里给 VoicePilot 授权，否则全局快捷键不生效）。在悬浮条上说话、停止后「复制」或「润色」。

### 自测

```bash
cd app
npx tsc --noEmit                          # 全量类型检查
VP_UI_SELFTEST=1 npx electron .           # 界面自测（隐藏窗口 + 假 bridge）
VP_STORE_SELFTEST=1 npx electron .        # 存储自测
VP_SM_SELFTEST=1 npx electron .           # 状态机自测
```

---

## Key 下发（内网端点）

打包版不再由人工分发 DashScope Key，改为**运行时从公司内网 HTTPS 端点取回**。试用者装完即用，不需要填任何东西。

```bash
# 1. 起服务端（部署在内网机器上，细节见 server/config-endpoint/README.md）
cd <repo>
export VP_CONFIG_TOKEN='<发给客户端的 token>'
export VP_DASHSCOPE_API_KEY='sk-…'
export VP_DASHSCOPE_WORKSPACE_ID='<业务空间 ID>'
export VP_CONFIG_VERSION=1
export VP_TLS_CERT=/etc/ssl/voicepilot/fullchain.pem
export VP_TLS_KEY=/etc/ssl/voicepilot/privkey.pem
node server/config-endpoint/server.js

# 2. 打包前注入端点地址与 token（此文件 gitignore，绝不入库）
cp app/electron/endpoint.example.json app/electron/endpoint.built.json
# 填入真实 endpoint 与 token
cd app && npm run dist:win:portable     # prepack-check 会拦住缺失/占位/非 https 的情况

# 3. 轮换 Key
#    改 VP_DASHSCOPE_API_KEY，并把 VP_CONFIG_VERSION 加一，重启服务端即可，不用重发包
# 4. 轮换 token
#    改 VP_CONFIG_TOKEN 之后**必须重新打包重发**（token 是打包时注入的）
```

**客户端行为**：启动时先读本地缓存（有就立刻可用，并在后台刷新）；没有任何可用凭据时才等一次端点（3 秒超时），失败则提示「未获取到授权，请联系管理员」+ 重试。托盘菜单有「重新获取授权」可手动重试，旁边还留着「设置 API Key」供管理员排查。

**自测**：

```bash
cd app
VP_CONFIG_SELFTEST=1 npx electron .   # 本地起 mock 端点，离线可跑
node ../server/config-endpoint/test.mjs
```

---

## 打包与分发（给同事试用）

```bash
cd app
npm run dist:win:portable   # 只打便携单文件版（快，推荐发同事试）
npm run dist:win            # 便携 + NSIS 安装包两个都打
```

产物在 `app/release/`（已 gitignore）：

| 文件 | 用途 |
|---|---|
| `VoicePilot 0.1.0.exe` | 便携单文件版，双击即用 |
| `VoicePilot Setup 0.1.0.exe` | NSIS 安装包（开始菜单 / 桌面快捷方式 / 卸载） |

macOS：

```bash
npm run dist:mac            # 打 dir + dmg（未签名）
```

产物为 `app/release/mac*/VoicePilot.app` 与 `app/release/VoicePilot-0.1.0.dmg`。

> macOS 上**必须先打包、从 `.app` 启动才能验证辅助功能授权**：开发模式 `npm start` 跑的是 `node_modules` 里的 `Electron.app`（bundle id 不同），系统设置里授权不到 VoicePilot。

**发同事试用的流程**：

1. 把 `VoicePilot 0.1.0.exe` 发给对方
2. 把 API Key + 工作空间 ID **单独**发给他（不要打进包里）
3. 对方双击 exe → 首次启动弹「设置 API Key」窗 → 填入 → 即可用
4. Key 经 `safeStorage` 加密存对方本机，之后不再弹；托盘菜单里也有「设置 API Key」可随时改

> 当前**两个平台都未做代码签名**。Windows 上 SmartScreen 会提示「未知发布者」，点「仍要运行」即可；macOS 未签名未公证，首次打开需「右键 → 打开」绕过 Gatekeeper。均为内部分发的预期情况（PRD §5.7）。

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

- **macOS 未签名 / 未公证**：已能打包运行（托盘图标、不抢焦点、公司内网证书三个打包后才暴露的问题均已修并复验），但未做 Developer ID 签名与公证，首次打开需「右键 → 打开」；辅助功能授权（F12 引导）待按打包后的 `.app` 复验。
- **Key 分发是临时的弹窗输入方案**：正式形态是 F11 配置端点下发（Key 不落客户端明文、可轮换），当前先用「启动弹窗输入 + safeStorage 加密落盘」过渡。
- **首次引导已启用**：职业维度已移除（2026-09-08），F8 改为欢迎页，首次启动弹一次；原 `VP_ENABLE_ONBOARDING` 开关已删除。
- **注入光标未做**：v1 输出终点是剪贴板，注入其他应用推迟到后续阶段。
- **历史搜索未做**：当前历史只支持浏览，全文搜索（FTS5）属下一批。
- **设置界面未做**：快捷键可配置、开机启动待开发（F7，归 M5-A）。「触发模式」已随 2026-09-11 的决定去掉——F1 只保留「按一下开始 / 再按一下停止」单模式；词表本期留空。
- **准确率无 ground truth**：字准确率验收依赖内部试用期的错误标记数据（M6）。
