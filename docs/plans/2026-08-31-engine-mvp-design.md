# VoicePilot 引擎 MVP 技术设计

- **日期**: 2026-08-31
- **状态**: Draft v0.1（待评审）
- **项目**: VoicePilot — 说话即成文的桌面语音输入引擎
- **Slogan**: 出口成章 · 中文昵称「闻字」

---

## 1. 一句话定位

VoicePilot 是一个**业务无关的桌面语音输入引擎**：按住快捷键说话，文字流式上屏、句尾自动修正，最终注入任意应用的光标处。润色与翻译不写在引擎里，而是作为 **per-app 的 prompt 规则层**叠加在引擎之上。

## 2. 背景与产品方向

- **市场判断**：通用 AI 语音输入已是红海（Wispr Flow / Typeless / Superwhisper 海外桌面派，豆包 / 微信 / 讯飞国内移动派）。Windows + 中文桌面端存在空档。
- **长期方向**：跨境电商卖家垂直工具（listing 创作 + 客服回复 + 多语言翻译），借 SellingPilot 渠道冷启动。但引擎先行，垂直场景退化为"一条 per-app 润色规则"，不锁死方向。
- **结构性优势**：ASR 与 LLM 均可经 **SmartRouter**（自有 OpenAI 兼容网关）统一路由与计费，成本结构自主可控。

## 3. MVP 目标与非目标

**目标**

1. 任意 Windows 应用中，按住全局快捷键说话，悬浮字幕条灰字流式上屏
2. VAD 检测句尾后，2-pass 整句修正并替换（黑字）
3. 松开快捷键后，文本注入当前光标位置
4. 延迟达成 §6 预算表

**非目标（MVP 明确不做）**

- macOS / Linux 支持（架构上预留 trait 抽象）
- LLM 润色 / 翻译（M4，P1 阶段）
- 移动端、离线本地 ASR、账号体系、云同步

## 4. 架构

```
┌─ UI 层     悬浮字幕条（WS_EX_NOACTIVATE，不抢焦点）
├─ 系统层    全局快捷键(rdev) · 音频采集(cpal) · VAD(Silero)
│            前台感知(Win32 GetForegroundWindow + UIA) · 文本注入(SendInput/剪贴板)
├─ ASR 层    WebSocket 流式 → SmartRouter → GLM-ASR（OpenAI 兼容接口）
├─ 修正层    partial 稳定策略 + 断句 2-pass 重转 + diff 替换   ← 引擎核心壁垒
├─ 润色层    per-app 规则表 → LLM 流式生成 → 替换（M4）
└─ 配置层    润色规则 / 热词 / 模型选择（JSON 文件，界面后置）
```

**技术栈**：Rust + Tauri 2.x（前端仅承载设置界面）；运行时依赖 SmartRouter 服务地址 + API Key。

**代码组织**：`crates/`（core / sys-win / asr-client / polish / config）+ `apps/desktop`（Tauri 壳）。系统层大量借鉴 Handy（MIT），替换其本地推理为远端流式 ASR。

## 5. 关键设计决策

### D1 ASR 走 SmartRouter 云端 API
- 首选 GLM-ASR（兼容 OpenAI SDK、支持流式、中文方言覆盖好）；备选百炼 Fun-ASR（7.7B，中文最强档）、豆包 Seed-ASR 2.0（上下文感知）
- ASR 抽象为 `trait AsrProvider`，未来插拔本地 FunASR（隐私卖点，二期）

### D2 系统层借 Handy，不重造轮子
- Handy（MIT，Tauri + Rust）已实现：全局快捷键、cpal 采集、Silero VAD、无焦点悬浮条、跨平台注入
- 保留其系统层，删除 whisper-rs / transcription-rs 推理层，接入 D1 的远端客户端

### D3 双层替换时序（本设计核心）
文本三态状态机：

| 状态 | 颜色 | 产生方式 | 变更规则 |
|------|------|----------|----------|
| `draft` | 灰 | 流式增量 | **只追加，不回删**（避免闪烁） |
| `corrected` | 黑 | 断句后 2-pass 重转 | 整句替换，diff 只回写改动部分 |
| `polished` | 高亮 | 润色层（M4） | 见 D4 |

触发链：Silero VAD 静音 ≥ **800ms** 判定句尾 → 对当前句发起整句重转 → 与 draft 做 diff → 仅替换有差异的字符段。

### D4 per-app 润色规则（M4，prompt 玩法）
- 规则表：`{ match: {process|title 正则}, prompt 模板, 目标语言, enabled }`
- 内置 Outlook（商务邮件）/ 微信（口语轻润色）/ 浏览器（默认关）三套模板，用户 JSON 自定义
- 润色流式生成，边生成边替换，替换前检测用户是否已手动编辑（编辑过则弹悬浮预览条确认，不静默覆盖）

### D5 文本注入策略
- 默认剪贴板 + 模拟 Ctrl+V（兼容性最好），注入后**恢复用户原剪贴板内容**
- 终端类应用回退 SendInput 逐字注入；注入失败（管理员窗口等）→ 悬浮条提示手动粘贴

## 6. 延迟预算

| 环节 | 目标 | 达成手段 |
|------|------|----------|
| 快捷键按下 → 开始采集 | < 100ms | 常驻录音线程 + WebSocket 连接预热 |
| 音频 → 灰字增量上屏 | < 600ms | 600ms chunk 流式 + 长连接 |
| 句尾修正替换 | < 1.5s | 2-pass 重转仅当前句，不等整段 |
| 润色替换（M4） | < 3s | LLM 流式生成，边出边换 |

## 7. 一次完整口述的数据流

1. 按住快捷键 → 前台感知快照（进程名 + 窗口标题 + 控件角色）→ 启动采集
2. 音频按 600ms chunk → WebSocket → ASR 流式返回 → draft 灰字追加
3. VAD 静音 800ms → 句尾：当前句整句重转 → diff 替换为 corrected 黑字
4. 循环 2–3 直至松开快捷键
5. 松开 →（M4：按 per-app 规则触发润色，流式替换）→ 注入光标处 → 恢复剪贴板

## 8. MVP 验收标准

- **Demo 脚本**：在记事本、Outlook 新邮件、Chrome 搜索框三处完成"按住说话 → 松开出字"
- **识别质量**：安静环境中文普通话，句级准确率 ≥ 95%（人工抽样 100 句）
- **延迟**：全部达成 §6 预算
- **稳定性**：连续 30 分钟口述无崩溃；网络抖动时 WebSocket 自动重连、不丢已识别文本

## 9. 里程碑

| 阶段 | 内容 | 出口条件 |
|------|------|----------|
| M1 | 系统层端到端：借 Handy 打通 快捷键→采集→(本地whisper临时顶替)→悬浮条→注入 | 三处 Demo 场景出字 |
| M2 | ASR 接入 SmartRouter：灰字流式上屏 | 600ms 预算达标 |
| M3 | 修正层：VAD 断句 + 2-pass + diff 替换 | 引擎核心验收（§8 全项） |
| M4 | 润色层 + 前台感知 + per-app 规则表（P1） | Outlook 规则 demo |

## 10. 风险与开放问题

- **R1** GLM-ASR 流式协议细节（chunk 格式 / 断连重连 / 会话管理）未经实测 → M2 第一天做 spike 验证
- **R2** 部分窗口（游戏全屏、管理员权限进程）注入失败 → 已有 D5 降级路径，验收标准不含这类窗口
- **R3** diff 替换在某些编辑器中引起滚动跳动 → 只在句尾一次性替换，绝不逐字回删
- **R4** 剪贴板恢复竞态（注入与恢复之间用户复制了新内容）→ 恢复前比对剪贴板哈希，被改则放弃恢复
- **开放**：VoicePilot 商标 / 域名查询未做；润色与用户手动编辑的冲突策略在 M4 落地时再细化

## 11. 参考资料

- Handy（系统层参考，MIT）: https://github.com/tachyonicbytes/Handy
- Dictata（Windows Rust，continuous mode + OpenAI 兼容 LLM 后处理参考）
- FunASR 2-pass 流式 runtime: https://github.com/modelscope/FunASR
- GLM-ASR（OpenAI 兼容流式 ASR，智谱）
- 产品参考：Wispr Flow（app-aware tone）、Superwhisper（modes）
