# VoicePilot 闻字

> **出口成章** · 说话即成文的桌面语音输入引擎

按住快捷键说话，文字实时上屏、句尾自动收敛定稿，最终注入任意应用的光标处。

---

## 想解决什么

现有的语音输入基本是「录音 → 转写 → 得到一段文字」。写作时真正想要的不是这个，而是**说话的时候文字就已经在长出来**——像打字一样，只是用手说。

VoicePilot 要做的是：

1. **边说边出字**，不是说完一段等结果。实测屏幕内容平均只落后说话 99 毫秒。
2. **自动收敛成文**。正在说的部分是灰色的（还在修正），说完停顿后定稿成白字——「出口成章」的核心机制，肉眼可见。
3. **写进你正在用的地方**。文字最终注入 Word、Outlook、浏览器输入框的光标处，而不是停留在自己的窗口里。

第 3 点是第二阶段。**当前阶段只验证前两点**，输出到自己的窗口。

### 与相近产品的差别

参照形态是 [Transync AI](https://www.transyncai.com/)（实时会议同传）。壳很像——悬浮窗、实时字幕、不抢焦点，但它做的是**翻译**，文字画在自己的窗口里就结束了；VoicePilot 要做**成文**，并且把文字写进别人的应用。

这个差别决定了难度：画完就完事 vs. 处理剪贴板竞态、中文输入法组字态、管理员权限窗口、终端回退。

---

## 当前进度

| | 状态 |
|---|---|
| 链路连通、ASR 选型 | ✅ 百炼 Paraformer 实时 WebSocket |
| 延迟实测 | ✅ 首字上屏 520ms / 跟随 P50 99ms / 定稿 P50 737ms，**全部达标** |
| 浏览器原型（演示用） | ✅ 可用 |
| 识别准确率（CER） | ⏸ 缺 ground truth 转写文本 |
| 修正层是否值得自建 | ⏸ 同上，取决于上面的数字 |
| 注入其他应用 | 第二阶段 |
| 桌面端（Rust + Tauri） | 待验证完成后启动 |

**已知短板**：英文与科技术语识别明显弱于中文（实测出现 `InfoQ→infq`、`token→拖困`）。中文长句骨架基本准确。对瞄准跨境电商的场景是核心风险，待量化。

详细设计与实测数据见 [`docs/plans/2026-08-31-engine-mvp-design.md`](docs/plans/2026-08-31-engine-mvp-design.md)。

---

## 快速开始：跑 demo

### 1. 配置凭证

```bash
cp .env.example .env
```

填入两个值，都在[百炼控制台](https://bailian.console.aliyun.com/)获取：

- `DASHSCOPE_API_KEY` — API Key
- `DASHSCOPE_WORKSPACE_ID` — **业务空间 ID**（不是 API Key，两个都要）

先验证链路，确认凭证没问题：

```bash
npm run smoke
```

### 2. 启动

```bash
npm install
npm run demo
```

浏览器打开 **http://localhost:3000**

### 3. 使用

- **按住空格**说话，松开停止
- 或切到「按一下开始」模式：按一下开始，再按一下停
- 说话时**停顿 1 秒以上**会自动另起一段
- 底部「技术说明」有这个原型在验证什么的解释

### 注意事项

- 用 **Chrome 或 Edge**
- 必须走 **localhost**（浏览器只在 localhost 下允许免 HTTPS 访问麦克风）
- 首次按空格会弹麦克风授权，要点「允许」
- **等状态变绿色「聆听中 — 请说话」再开口**。从按下到会话就绪约 300ms，这期间的音频不会发出去，开头会丢字

---

## 测量工具

`spike/` 是验证用的工具链，不是产品代码。

```bash
# 转码：把录音转成 16kHz/16bit/单声道（Windows 录音机默认是 48kHz 立体声，不转会导致延迟测量全错）
npm run normalize -- spike/audio/你的录音.wav

# 主探针：输出延迟、中间结果抖动、CER
npm run probe -- --audio spike/audio/01-dictation-16k.wav --truth spike/audio/01-dictation-16k.txt

# 只测延迟（不传 ground truth 就跳过准确率）
npm run probe -- --audio spike/audio/01-dictation-16k.wav

# 对比语义断句（准确率更高但延迟更高）
npm run probe -- --audio spike/audio/01-dictation-16k.wav --semantic
```

结果 JSON 落在 `spike/results/`，含每一次中间结果的快照，可以回看灰字是怎么一步步变成黑字的。

录音素材清单见 [`spike/audio/README.md`](spike/audio/README.md)。

---

## 项目结构

```
├── demo/                     浏览器原型（演示用）
│   ├── server.js             Node 转发层（仅透传，不加工数据）
│   └── public/index.html     单页界面
├── spike/                    测量与验证工具
│   ├── lib/wav.js            WAV 解析 + 按真实时间回放 + 转码
│   ├── lib/paraformer.js     百炼实时识别客户端（一次性 / 流式两种）
│   ├── probe.js              主探针
│   ├── normalize.js          音频转码
│   ├── smoke.js              链路自检
│   └── audio/                录音素材与 ground truth
├── docs/plans/               设计文档
└── package.json
```

### 为什么 demo 需要一个 Node 转发层

浏览器的 `WebSocket` API **不支持自定义请求头**，无法携带 `Authorization`，所以浏览器连不上百炼；而且 API Key 放前端等于公开。转发层只做透传，不加工任何数据。

---

## 已知限制

- 只验证核心识别能力，**不做注入**——文字只显示在自己的窗口里
- 未验证 SmartRouter（自有网关）能否转发 WebSocket，当前直连百炼
- 准确率未量化，缺 ground truth 转写文本
- 音频前端（设备、AGC、降噪）未设计，当前用浏览器默认采集
