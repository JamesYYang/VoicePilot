# VoicePilot 引擎 MVP 技术设计

- **初稿**: 2026-08-31（Draft v0.1）
- **修订**: 2026-09-03（Draft v0.2，根据 API 实测结果重写）
- **项目**: VoicePilot（中文名「闻字」）— 说话即成文的桌面语音输入引擎
- **Slogan**: 出口成章

---

## 0. 本次修订改了什么（v0.1 → v0.2）

v0.1 建立在若干未经验证的假设上。2026-09-02 的外部依赖核实与 09-03 的实测**推翻了其中三条**，因此重写：

| # | v0.1 的假设 | 实测结论 | 影响 |
|---|---|---|---|
| 1 | GLM-ASR 支持 WebSocket 流式 | 只有 multipart 上传完整文件（≤25MB/≤30s），`stream=true` 是输出侧 SSE 而非音频侧分块 | ASR 换**百炼 Paraformer 实时 WS**，§4/§6/§7 全改 |
| 2 | 客户端用 Silero VAD 800ms 判句尾 | 服务端自带断句（`max_sentence_silence` 默认 1300ms），且连续口述时按**语义**断句而非等静音 | 客户端 VAD 只管「何时开始/停止送音频」，§5/D2 改写 |
| 3 | 自建 2-pass 修正产生 corrected | 服务端 `result-generated` 自带 `sentence_end`，天然区分中间结果与定稿 | **自建 2-pass 的必要性变成待验证项**，§5/D3、§8 改写 |

此外，**MVP 范围与验证方式也变了**：

- **不做注入**：MVP 只输出到自己的窗口，注入其他应用推迟到第二阶段
- **先用浏览器原型验证**：不做桌面端，等技术能力和产品方向都验证完再启动 Rust/Tauri

---

## 1. 一句话定位

VoicePilot 是一个**业务无关的桌面语音输入引擎**：说话，文字实时上屏、句尾自动收敛定稿，最终注入任意应用的光标处。润色与翻译不写在引擎里，而是作为 **per-app 的 prompt 规则层**叠加在引擎之上。

**MVP 只验证前半段**（实时上屏 + 收敛定稿 + 输出到自己的窗口）；**注入是第二阶段**。

---

## 2. 背景与产品方向

### 市场判断

通用 AI 语音输入已是红海（Wispr Flow / Typeless / Superwhisper 海外桌面派，豆包 / 微信 / 讯飞国内移动派）。Windows + 中文桌面端存在空档。

### 长期方向

跨境电商卖家垂直工具（listing 创作 + 客服回复 + 多语言翻译），借 SellingPilot 渠道冷启动。但引擎先行，垂直场景退化为「一条 per-app 润色规则」，不锁死方向。

### 形态参照：Transync AI（同言翻译）

2026-09-03 用户提出的产品形态参照。实时会议同传：端到端语音大模型、官方标称 <500ms、60 语言、悬浮双语字幕窗、Windows/Mac/iOS/Android 全端，目标客户写明「外贸销售 / 跨境」。

**重合的只有「壳」**——黑底置顶悬浮窗、记住位置、不抢焦点、可暂停。这套直接借鉴。

**差异在「核」**：

| | Transync AI | VoicePilot |
|---|---|---|
| 输出终点 | 画在自己的窗口 / 语音播报 | **写进别人的应用** |
| 音频源 | 麦克风 + 系统音频（听双方） | 仅麦克风 |
| 断句修正 | 无 | draft → corrected 收敛 |
| per-app 润色 | 无 | 有（M4） |

关键含义：**输出终点不同导致难度差一个数量级**。Transync 画完就完事，我们要处理剪贴板竞态、中文 IME 组字态、管理员窗口、终端回退。形态相似不代表工作量相似。

### 结构性优势

ASR 与 LLM 拟经 **SmartRouter**（自有 OpenAI 兼容网关）统一路由与计费。**尚未验证**：其 multipart / WebSocket 转发能力未知，spike 阶段先直连百炼以排除干扰，转发能力推迟到 M2 单独验证。

---

## 3. MVP 目标与非目标

### 目标（只有两条，都是待验证的假设）

1. **验证听写的及时性** —— 延迟能否支撑「说话即成文」的体感
2. **验证 draft → corrected 的有效性** —— 修正收敛到底带来多少准确率提升

两条都已用真实音频跑通测量工具（`spike/`），第 1 条已出结论，第 2 条**缺 ground truth 尚未出数**。

### 非目标（MVP 明确不做）

- **注入其他应用**（第二阶段。连带推迟：剪贴板竞态、IME 组字态、管理员窗口、终端回退）
- 桌面端（Rust + Tauri）——等上面两条验证完再启动
- LLM 润色 / 翻译
- macOS / Linux、离线本地 ASR、账号体系、云同步

---

## 4. 架构

### 验证阶段（当前）

```
┌─ 浏览器     空格键触发 · getUserMedia 采集 · AudioWorklet 降采样到 16kHz
│             灰字/白字两态渲染 · 按停顿分段
├─ Node 转发层  仅透传，不加工数据（浏览器 WS 不支持自定义请求头，
│             无法携带 Authorization；且 API Key 不能放前端）
└─ ASR        阿里云百炼 Paraformer 实时 WebSocket
```

### 目标架构（验证通过后）

```
┌─ UI 层     悬浮字幕条（WS_EX_NOACTIVATE，不抢焦点）
├─ 系统层    全局快捷键(rdev) · 音频采集(cpal) · VAD(Silero，仅管起停)
│            前台感知(Win32 GetForegroundWindow + UIA) · 文本注入
├─ ASR 层    百炼 Paraformer 实时 WebSocket（经 SmartRouter，待验证）
├─ 修正层    partial 稳定策略 + diff 替换（必要性待验证）
├─ 润色层    per-app 规则表 → LLM 流式生成 → 替换（M4）
└─ 配置层    润色规则 / 热词 / 模型选择
```

**技术栈**：验证阶段 Node + 浏览器；目标架构 Rust + Tauri 2.x。

---

## 5. 关键设计决策

### D1 ASR 选百炼 Paraformer 实时 WS（**已定，实测通过**）

- Endpoint：`wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`
- 流程：`run-task` → 二进制音频流 → `result-generated` 增量 → `finish-task`
- 模型 `paraformer-realtime-v2`（支持任意采样率），格式 `pcm` 单声道
- 仅华北 2（北京）；官方 SDK 只有 Java/Python，其他语言需自写 WS 客户端

**为什么不用 GLM-ASR**：它不是流式接口，`stream=true` 是输出侧 SSE。用它只能做分段式，首字延迟被接口锁死在 1.5–3s，无法达成延迟目标。

**为什么直连而不走 SmartRouter**：spike 要测的是 ASR 自身的延迟上限，中间垫一层网关会污染数据。转发能力推迟到 M2 单独验证。

### D2 句尾判定交给服务端（**改**）

放弃 v0.1 的「客户端 Silero VAD 静音 800ms 判句尾」。服务端自带断句：

- `max_sentence_silence` 默认 **1300ms**（范围 200–6000），可调
- `semantic_punctuation_enabled` 可切语义断句（准确率高、延迟高，适合会议转写）vs VAD 断句（延迟低，适合交互）

客户端 Silero VAD 的职责收缩为**「何时开始/停止送音频」**（省流量、省电量），句尾判定交给服务端。

实测佐证：连续口述时相邻句间隔仅 240–620ms，服务端显然是按语义断句而非等静音结束。

### D3 draft → corrected：服务端已提供，自建 2-pass **待验证**（**改**）

`result-generated` 的 `sentence_end` 字段天然区分两态：

| `sentence_end` | 含义 | 对应 UI |
|---|---|---|
| `false` | 中间结果，还会变 | 灰字 |
| `true` | 句子定稿 | 白字 |

**这意味着服务端已经在做「中间结果收敛成定稿」**。因此 v0.1 的 D3（整句 2-pass 重转）不再是必需项，而是**待验证项**：

- 取每句**最后一次中间结果**拼起来算 CER（draft）
- 取**定稿句子**拼起来算 CER（corrected）
- 两者的差 = 自建 2-pass 修正层的收益上限

判定标准：差值 <0.5% 则不该做；0.5%–2% 需权衡成本；>2% 值得做。

**该验证尚未完成**——缺 ground truth 转写文本。

### D4 先用浏览器原型验证（**新增**）

MVP 范围是「输出到自己的窗口、不做注入」，网页版完全覆盖；桌面端不可替代的两件事（全局快捷键、注入任意应用）本就是第二阶段的事。因此先用浏览器原型验证核心能力，避免方向未定时投入桌面端成本。

### D5 文本注入策略（第二阶段，**保留设计**）

- 默认剪贴板 + 模拟 Ctrl+V，注入后**恢复用户原剪贴板内容**
- 终端类应用回退 `SendInput` 逐字注入（中文需 `KEYEVENTF_UNICODE`）；注入失败 → 悬浮条提示手动粘贴
- 三个已知坑：Ctrl+V 后须等目标应用处理完再恢复剪贴板；恢复要枚举还原所有 format；中文 IME 组字态会吞掉 Ctrl+V，注入前需检测并清空合成状态

---

## 6. 延迟预算

v0.1 是估算，v0.2 全部替换为**实测值**（2026-09-03，49.5s 中文连续口述，百炼 Paraformer 实时，本地网络）：

| 指标 | 实测 | v0.1 预算 | 结论 |
|---|---|---|---|
| 首字上屏 | **520 ms** | < 600 ms | 达标 |
| 跟随延迟 P50 | **99 ms** | — | 屏幕基本贴着说话 |
| 跟随延迟 P90 | **210 ms** | — | |
| 句尾定稿 P50 | **737 ms** | < 1500 ms | 达标 |
| 句尾定稿 P90 | **841 ms** | — | |

*「跟随延迟」= 屏幕内容落后说话多少。原先用「每个字首次出现的延迟」统计得到 P50=5404ms，属口径错误：服务端每次推送都重算字时间戳（全篇 `begin_time` 重复率仅 12.8%），去重失效把句首的字反复当作新字。*

**结论：及时性达标，且余量充足。百炼实时 WS 这条路选对了。**

---

## 7. 一次完整口述的数据流

1. 触发（按住空格 / 按一下开始）→ 建立会话（`run-task` → `task-started`，约 300ms）
2. 音频按 100ms 分块持续推送 → 服务端持续返回 `result-generated`
3. `sentence_end=false` → 更新灰字；`true` → 该句定稿转白字
4. 停止 → `finish-task` → 收完剩余结果 → `task-finished`

**UI 侧注意**：服务端每次推送的是**整句重算结果**（累积文本，非增量），客户端必须自己做 diff 只追加新增部分，否则整段重绘会持续闪烁。且因字时间戳会被重算，**不能用时间戳做对齐**，只能靠文本 diff。

---

## 8. MVP 验收标准

| 项 | 标准 | 状态 |
|---|---|---|
| 延迟 | 达成 §6 全部预算 | ✅ 已验证 |
| 识别质量 | 安静环境中文普通话，字准确率 ≥ 95% | ⏸ 缺 ground truth |
| **修正增益** | draft 与 corrected 的 CER 差值（判定是否自建 2-pass） | ⏸ 缺 ground truth |
| 稳定性 | 连续 30 分钟口述无崩溃；断线重连不丢已识别文本 | ⏸ 未测 |

**已知质量短板**：英文 / 科技术语识别明显弱于中文。实测样本中出现 `InfoQ→infq`、`token→拖困`、「AI 进来」→「A镜头变成数字」。中文长句骨架基本准确。

这对瞄准跨境电商的场景是**核心风险**——目标用户的话里必然塞满 SKU、listing、CTR 这类词。需录中英混排与专有名词素材量化，并验证热词（`vocabulary_id`）能否救回来。

---

## 9. 里程碑（重排）

| 阶段 | 内容 | 状态 |
|---|---|---|
| Spike | 工具链 + 链路验证 + 延迟实测 | ✅ 完成 |
| P0 | 浏览器原型（演示用，向决策者验证方向） | ✅ 完成 |
| — | **补 ground truth，出 CER 与修正增益结论** | ⏸ **下一步** |
| — | 录中英混排 / 专有名词素材，量化术语短板 + 验热词 | ⏸ 待做 |
| M1 | 系统层：快捷键 → 采集 → 悬浮窗（Rust + Tauri） | 待方向确认后启动 |
| M2 | 接真 ASR（含验证 SmartRouter 转发）+ 延迟埋点 | |
| M3 | 断句策略 + 修正层（是否做取决于修正增益） | |
| M4 | 第二阶段：注入其他应用 | |
| M5 | 润色层 + 前台感知 + per-app 规则表 | |

---

## 10. 风险与开放问题

**R1** 自建 2-pass 修正层可能根本不需要 —— 服务端 `sentence_end` 已提供收敛。待 CER 数据判定。

**R2** 英文 / 科技术语识别短板 —— 对跨境电商场景是核心风险，热词能否救回未验证。

**R3** 决策风险 —— 项目是否继续取决于向领导的汇报结果（2026-09-03 用户提出）。

**R4** 字时间戳不可靠 —— 服务端每次推送都重算，全篇 `begin_time` 重复率仅 12.8%。任何依赖字级时间戳对齐的功能（高亮跟随、按字回删）都必须改用文本 diff。

**R5** 成本 —— 2-pass 若启用则 ASR 费用翻倍；`prompt` 有 8000 字上限，长口述需滑动窗口。

**R6** 触发模型 —— 按住式与「连续 30 分钟口述」矛盾，需 toggle 模式（原型中两种都做了）。

**R7** 音频前端 —— 设备、采样率、AGC、降噪未设计，≥95% 准确率目前建立在未定义的采集链路上。

**R8** SmartRouter 转发能力未验证 —— multipart 二进制 / WebSocket 转发是否可行，推迟到 M2。

**开放**：VoicePilot 商标 / 域名查询未做；翻译是否进 MVP 未定；Rust 工具链尚未安装。

---

## 11. 参考资料

- 百炼 Paraformer 实时语音识别 WebSocket API: https://help.aliyun.com/zh/model-studio/websocket-for-paraformer-real-time-service
- 客户端事件（run-task 参数全集）: https://help.aliyun.com/zh/model-studio/paraformer-client-events
- 服务端事件（result-generated 结构）: https://help.aliyun.com/zh/model-studio/paraformer-server-events
- Handy（系统层参考，MIT）: https://github.com/tachyonicbytes/Handy
- Transync AI（产品形态参照）: https://www.transyncai.com/
- FunASR 2-pass 流式 runtime: https://github.com/modelscope/FunASR
- 产品参考：Wispr Flow（app-aware tone）、Superwhisper（modes）
