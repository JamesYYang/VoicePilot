import { parseArgs } from 'node:util';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { readWav } from './lib/wav.js';
import { ParaformerClient } from './lib/paraformer.js';

const { values: args } = parseArgs({
  options: {
    audio: { type: 'string' },
    truth: { type: 'string' },
    'chunk-ms': { type: 'string', default: '100' },
    model: { type: 'string', default: 'paraformer-realtime-v2' },
    semantic: { type: 'boolean', default: false },
    silence: { type: 'string' },
    'no-itn': { type: 'boolean', default: false },
    'no-punct': { type: 'boolean', default: false },
    disfluency: { type: 'boolean', default: false },
    lang: { type: 'string' },
    vocab: { type: 'string' },
    out: { type: 'string', default: 'spike/results' },
  },
});

if (!args.audio) {
  console.error('用法: npm run probe -- --audio spike/audio/xxx.wav [--truth spike/audio/xxx.txt]');
  console.error('\n常用开关:');
  console.error('  --semantic          开语义断句（准确率更高、延迟更高）');
  console.error('  --silence 800       VAD 断句静音阈值 ms，默认 1300，范围 200-6000');
  console.error('  --no-itn            关闭逆文本规范化（看数字是否被转换）');
  console.error('  --no-punct          关闭标点预测');
  console.error('  --disfluency        过滤语气词（嗯、啊）');
  console.error('  --lang zh,en        语种提示');
  process.exit(1);
}

const params = {
  semantic_punctuation_enabled: args.semantic,
  inverse_text_normalization_enabled: !args['no-itn'],
  punctuation_prediction_enabled: !args['no-punct'],
  disfluency_removal_enabled: args.disfluency,
};
if (args.silence) params.max_sentence_silence = Number(args.silence);
if (args.lang) params.language_hints = args.lang.split(',');
if (args.vocab) params.vocabulary_id = args.vocab;

const { pcm, durationMs } = readWav(args.audio);
const chunkMs = Number(args['chunk-ms']);

console.log(`音频: ${basename(args.audio)}  时长 ${(durationMs / 1000).toFixed(1)}s  分块 ${chunkMs}ms`);
console.log(`模型: ${args.model}`);
console.log(`参数: ${JSON.stringify(params)}`);
console.log('');

const client = new ParaformerClient({
  apiKey: process.env.DASHSCOPE_API_KEY,
  workspaceId: process.env.DASHSCOPE_WORKSPACE_ID,
  model: args.model,
});

const totalChunks = Math.ceil(pcm.length / Math.round((16000 * 2 * chunkMs) / 1000));
const startedAt = Date.now();

const result = await client.recognize({
  pcm,
  params,
  chunkMs,
  onChunk: (i) => {
    if (i === 0) process.stdout.write('识别中 ');
    if (i % 10 === 0) process.stdout.write('.');
  },
});

process.stdout.write(` 完成 (${((Date.now() - startedAt) / 1000).toFixed(1)}s)\n\n`);

const report = analyze(
  result,
  { totalChunks, durationMs, params, model: args.model, audio: args.audio },
  (ms) => result.playback.sentAtOf(ms)
);

if (args.truth) {
  const truth = normalize(readFileSync(args.truth, 'utf8'));
  report.accuracy = scoreAgainstTruth(report.sentences, truth);
}

printReport(report, !!args.truth);

mkdirSync(args.out, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outPath = `${args.out}/${stamp}-${basename(args.audio, '.wav')}.json`;
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`\n完整数据: ${outPath}`);

// ---------- 分析 ----------

function analyze(result, meta, sentAtOf) {
  const { events } = result;

  // 按 sentence_end 切分：连续的中间结果 + 一个最终结果 = 一句话
  const sentences = [];
  let current = null;
  const realEvents = events.filter((e) => !e.heartbeat);

  for (const e of realEvents) {
    if (!current) current = { drafts: [], final: null };
    if (e.sentenceEnd) {
      current.final = e;
      sentences.push(current);
      current = null;
    } else {
      current.drafts.push(e);
    }
  }
  if (current && current.drafts.length > 0) sentences.push(current);

  // 字级首次出现延迟。同一个 begin_time 的字会在多轮中间结果里重复出现，
  // 只有第一次才是用户真正感知到的「这个字多久才冒出来」。
  const seenWords = new Set();
  const wordLatencies = [];
  for (const e of realEvents) {
    for (const w of e.words) {
      const key = `${w.begin_time}`;
      if (seenWords.has(key)) continue;
      seenWords.add(key);
      wordLatencies.push(e.recvAtMs - sentAtOf(w.begin_time));
    }
  }

  const sentenceFinalLatency = sentences
    .filter((s) => s.final)
    .map((s) => {
      const words = s.final.words;
      const endAudioMs = s.final.endTime ?? (words.length ? words[words.length - 1].end_time : null);
      return endAudioMs == null ? null : s.final.recvAtMs - sentAtOf(endAudioMs);
    })
    .filter((v) => v != null);

  return {
    meta: { ...meta, audioDurationMs: Math.round(durationMs), eventCount: realEvents.length },
    latency: {
      firstWordMs: wordLatencies.length ? wordLatencies[0] : null,
      wordP50Ms: percentile(wordLatencies, 50),
      wordP90Ms: percentile(wordLatencies, 90),
      wordMaxMs: wordLatencies.length ? Math.max(...wordLatencies) : null,
      sentenceFinalP50Ms: percentile(sentenceFinalLatency, 50),
      sentenceFinalP90Ms: percentile(sentenceFinalLatency, 90),
    },
    jitter: {
      sentenceCount: sentences.length,
      draftUpdatesPerSentence: avg(sentences.map((s) => s.drafts.length)),
      maxDraftUpdates: sentences.length ? Math.max(...sentences.map((s) => s.drafts.length)) : 0,
    },
    usage: result.usage,
    finalText: sentences
      .filter((s) => s.final)
      .map((s) => s.final.text)
      .join(''),
    sentences: sentences.map((s) => ({
      draftSnapshots: s.drafts.map((d) => ({ text: d.text, recvAtMs: d.recvAtMs })),
      finalText: s.final?.text ?? null,
      draftUpdateCount: s.drafts.length,
      finalLatencyMs:
        s.final && s.final.words.length
          ? s.final.recvAtMs -
            sentAtOf(s.final.endTime ?? s.final.words[s.final.words.length - 1].end_time)
          : null,
    })),
  };
}

/**
 * 对照 ground truth 计算 CER，并分别评估 draft / corrected。
 *
 * 这是本 spike 的核心：sentence_end=false 的中间结果就是 draft，
 * sentence_end=true 就是 corrected。两者的字准确率差，决定了我们是否
 * 还需要自建 2-pass 修正层。
 */
function scoreAgainstTruth(sentences, truth) {
  const lastDraft = sentences.map((s) => (s.drafts.length ? s.drafts[s.drafts.length - 1].text : '')).join('');
  const corrected = sentences.map((s) => s.final?.text ?? '').join('');

  const truthChars = [...truth];
  const score = (text) => {
    const hyp = [...normalize(text)];
    if (truthChars.length === 0) return { cer: null };
    return {
      cer: +(levenshtein(truthChars, hyp) / truthChars.length).toFixed(4),
      chars: hyp.length,
    };
  };

  const draftScore = score(lastDraft);
  const correctedScore = score(corrected);

  return {
    referenceChars: truthChars.length,
    draft: draftScore,
    corrected: correctedScore,
    // 正值 = corrected 比 draft 好，这就是「修正层是否值得做」的量化依据
    improvement: draftScore.cer != null && correctedScore.cer != null
      ? +(draftScore.cer - correctedScore.cer).toFixed(4)
      : null,
    draftText: lastDraft,
    correctedText: corrected,
    referenceText: truth,
  };
}

// ---------- 工具 ----------

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

// 去掉标点/空白/符号后再比对：ground truth 一般不带标点，而 ASR 会输出标点
function normalize(text) {
  return text.replace(/[\s\p{P}\p{S}]/gu, '');
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[idx]);
}

function avg(arr) {
  if (!arr.length) return null;
  return +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2);
}

function printReport(report, hasTruth) {
  const { latency, jitter, meta } = report;

  console.log('── 延迟（音频发出 → 结果到达，含网络往返）');
  console.log(`  首字            ${fmt(latency.firstWordMs)}`);
  console.log(`  字级 P50        ${fmt(latency.wordP50Ms)}`);
  console.log(`  字级 P90        ${fmt(latency.wordP90Ms)}`);
  console.log(`  句尾定稿 P50    ${fmt(latency.sentenceFinalP50Ms)}`);
  console.log(`  句尾定稿 P90    ${fmt(latency.sentenceFinalP90Ms)}`);

  console.log('\n── 中间结果抖动（灰字闪烁程度）');
  console.log(`  句子数          ${jitter.sentenceCount}`);
  console.log(`  每句中间更新    ${jitter.draftUpdatesPerSentence} 次`);
  console.log(`  单句最多更新    ${jitter.maxDraftUpdates} 次`);

  if (report.accuracy) {
    const a = report.accuracy;
    console.log('\n── 准确率（对照 ground truth）');
    console.log(`  参考字数        ${a.referenceChars}`);
    console.log(`  draft CER       ${a.draft.cer}  (字准确率 ${((1 - a.draft.cer) * 100).toFixed(1)}%)`);
    console.log(`  corrected CER   ${a.corrected.cer}  (字准确率 ${((1 - a.corrected.cer) * 100).toFixed(1)}%)`);
    console.log(`  修正带来的提升  ${a.improvement}`);
    if (a.improvement != null) {
      const verdict =
        a.improvement < 0.005
          ? '→ 提升 <0.5%：自建 2-pass 修正层的必要性存疑'
          : a.improvement < 0.02
            ? '→ 提升 0.5%–2%：修正有价值但不显著，需权衡成本'
            : '→ 提升 >2%：修正层值得做';
      console.log(`  ${verdict}`);
    }
    console.log('\n  参考文本:');
    console.log(`    ${a.referenceText}`);
    console.log('  corrected:');
    console.log(`    ${a.correctedText}`);
  } else {
    console.log('\n（未传 --truth，跳过准确率。提供 ground truth 才能算 CER 与修正提升）');
  }

  console.log('\n── 最终文本');
  console.log(`  ${report.finalText}`);

  if (report.usage) console.log(`\n计费时长: ${report.usage.duration}s`);
  console.log(`事件总数: ${meta.eventCount}`);
}

function fmt(ms) {
  return ms == null ? '—' : `${ms} ms`;
}
