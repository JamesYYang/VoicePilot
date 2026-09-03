# 录音素材清单

这些音频是 spike 的输入，所有延迟和准确率数字都建立在它们之上。**先跑通 `node spike/smoke.js` 再录音**，避免凭证有问题白录。

## 格式要求

必须是 **16kHz / 16bit / 单声道 PCM WAV**。脚本会严格校验，不符就报错并给转码命令。

转码（需要 ffmpeg，没有就 `winget install ffmpeg`）：

```bash
ffmpeg -i 你的录音.m4a -ar 16000 -ac 1 -c:a pcm_s16le spike/audio/01-dictation.wav
```

Windows 自带「录音机」录出来通常是 48kHz，必须转，否则按 16kHz 回放会导致音频变慢、延迟测量全错。

## 要录的五段

每段 30–60 秒即可，别太长——spike 要反复跑参数矩阵，长音频拖慢迭代。

| 文件 | 说什么 | 用来验证 |
|---|---|---|
| `01-dictation.wav` | 一段自然连续口述，像平时写东西那样说，带正常停顿 | **首字延迟、句尾延迟、断句粒度**。主样本 |
| `02-numbers.wav` | 含日期、数字、百分比、金额。如「二零二六年九月三日出货三千二百件，客单价三十九块九，转化率百分之十二点五」 | **ITN**：ASR 是否把「二零二六年」转成「2026年」 |
| `03-mixed.wav` | 中英混排，用你真实会说的词。如「把这个 SKU 的 listing 优化一下，CTR 太低」 | 混排识别能力 |
| `04-terms.wav` | 品牌名、产品名、人名等专有名词 | **热词**是否必要（先测无热词基线，有提升才值得配） |
| `05-pauses.wav` | 一句话中间故意停 0.5–1 秒换气，再继续 | **断句阈值**：会不会被过早切成两句 |

## 配套 ground truth

每个 `.wav` 配一个同名 `.txt`，逐字写下你**实际说出的内容**：

```
spike/audio/01-dictation.wav
spike/audio/01-dictation.txt
```

要求：

- 逐字准确，不要「修正」成书面语——我们要比对的是 ASR 听错了什么，你先改就测不出来了
- 标点随意写，脚本比对前会把标点和空白全部去掉
- 语气词「嗯」「啊」也算进去

这一步枯燥但是整个准确率评估的基准，糊弄了后面所有 CER 数字都没有意义。

## 录音环境

- 安静房间，关掉风扇和音乐
- 麦克风距嘴 20–30cm，固定不动
- 正常语速、正常音量，别刻意放慢或咬字——刻意的表现会让测出的准确率虚高

## 跑法

```bash
# 先验证链路
node spike/smoke.js

# 单条，带准确率
npm run probe -- --audio spike/audio/01-dictation.wav --truth spike/audio/01-dictation.txt

# 只测延迟，跳过准确率
npm run probe -- --audio spike/audio/05-pauses.wav

# 对比语义断句（准确率更高但延迟更高）
npm run probe -- --audio spike/audio/01-dictation.wav --truth spike/audio/01-dictation.txt --semantic

# 调 VAD 断句静音阈值（默认 1300ms，范围 200-6000）
npm run probe -- --audio spike/audio/05-pauses.wav --silence 800

# 看 ITN 关掉会怎样
npm run probe -- --audio spike/audio/02-numbers.wav --no-itn
```

结果 JSON 落在 `spike/results/`，含每一次中间结果的快照，可以回看灰字的演变过程。
