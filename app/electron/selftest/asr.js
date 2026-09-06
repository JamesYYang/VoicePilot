import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCredentials } from '../asr/config.js';
import { AsrSession } from '../asr/session.js';
import { LatencyMetrics, formatSummary } from '../telemetry/metrics.js';

/**
 * ASR 离线自测。用法：
 *   cd app && VP_ASR_SELFTEST=1 npx electron .
 *
 * 存在的理由：它是后续所有 ASR 改动的**回归基线**。
 * 用一段固定音频 + 固定参数跑完整会话，输出的文本与延迟数字可以和
 * 2026-09-04 的 spike 离线实测直接比对。改了参数、换了模型、动了发送节奏，
 * 跑一遍就知道有没有把识别质量或延迟搞坏 —— 不用每次都靠人开口说话。
 *
 * 必须在 Electron 里跑（而不是纯 Node）：config.js 依赖 app.isPackaged 做守卫，
 * 而且我们要验的就是主进程这条真实路径。
 *
 * 会真实调用百炼并产生费用。单次一段素材，费用可忽略。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// app/electron/selftest → 上三级是仓库根
const REPO = resolve(HERE, '..', '..', '..');
const WAV = resolve(REPO, 'spike/audio/01-dictation-16k.wav');
const TRUTH = resolve(REPO, 'spike/audio/01-dictation.draft.txt');

const CHUNK_MS = 100;
const CHUNK_BYTES = 3200; // 16000Hz × 2字节 × 100ms
const SAMPLES_PER_CHUNK = CHUNK_BYTES / 2;

/**
 * 极简 WAV 读取：只认 16kHz / 16bit / 单声道 PCM。
 *
 * 不从 spike/lib/wav.js 导入，是刻意让 app/ 保持自包含 —— spike/ 是研究工具，
 * 让产品目录反向依赖它会一直纠缠到打包阶段。
 * 这里只服务自测，格式不符直接抛错即可。
 */
function readPcm16kMono(path) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path}: 不是合法的 WAV`);
  }

  let fmt = null;
  let data = null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && size >= 16) {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, body + Math.min(size, buf.length - body));
    }
    offset = body + size + (size % 2);
  }

  if (!fmt || !data) throw new Error(`${path}: 缺少 fmt 或 data chunk`);
  if (fmt.channels !== 1 || fmt.sampleRate !== 16000 || fmt.bits !== 16) {
    throw new Error(
      `${path}: 需要 16kHz/16bit/单声道，实际 ${fmt.sampleRate}Hz/${fmt.bits}bit/${fmt.channels}声道`
    );
  }
  return new Int16Array(data.buffer, data.byteOffset, Math.floor(data.length / 2));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runAsrSelftest() {
  console.log(`[自测] 音频 ${WAV}`);

  let creds;
  try {
    creds = loadCredentials();
  } catch (e) {
    // 凭据拿不到是最常见的前置问题，说清楚怎么办，别只抛一句错误码
    console.error(`[自测] 失败：${e.message}`);
    console.error('[自测] 请在仓库根 .env 里填好 DASHSCOPE_API_KEY 与 DASHSCOPE_WORKSPACE_ID');
    return { ok: false, reason: 'credentials' };
  }

  const pcm = readPcm16kMono(WAV);
  const durationMs = (pcm.length / 16000) * 1000;
  let truth = '';
  try {
    truth = readFileSync(TRUTH, 'utf8').trim();
  } catch {
    console.warn(`[自测] 读不到 ${TRUTH}，跳过文本比对`);
  }

  const metrics = new LatencyMetrics();
  const committed = [];
  let draft = '';
  const errors = [];

  const session = new AsrSession({
    ...creds,
    onResult: (ev) => {
      metrics.onResult(ev);
      if (ev.sentenceEnd) {
        committed.push(ev.text);
        draft = '';
      } else {
        draft = ev.text;
      }
    },
    onError: (e) => {
      errors.push(e);
      console.error(`[自测] 会话错误 kind=${e.kind} code=${e.code} ${e.message}`);
    },
    onClosed: (e) => {
      errors.push(e);
      console.error(`[自测] 连接被关闭 kind=${e.kind} code=${e.code}`);
    },
  });

  metrics.markToggle();

  console.log(`[自测] 时长 ${(durationMs / 1000).toFixed(1)}s，按真实节奏回放…`);
  await session.start();
  console.log('[自测] task-started，开始推流');

  const t0 = Date.now();
  for (let i = 0, off = 0; off < pcm.length; i++, off += SAMPLES_PER_CHUNK) {
    const slice = pcm.subarray(off, Math.min(off + SAMPLES_PER_CHUNK, pcm.length));
    const r = session.sendAudio(Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength));
    if (r.ok) {
      metrics.onSend({
        cumSamples: off + slice.length,
        batchSamples: slice.length,
        sentAtMs: r.sentAtMs,
      });
    }
    if (off + SAMPLES_PER_CHUNK >= pcm.length) break;
    // 对齐绝对时刻而非累加间隔，避免漂移（与 PacedPlayback 同做法）
    const wait = t0 + (i + 1) * CHUNK_MS - Date.now();
    if (wait > 0) await sleep(wait);
  }

  metrics.markStop();
  const { truncated } = await session.stop();
  metrics.markReviewing();

  const summary = metrics.finish();
  const file = await metrics.save(summary);

  const text = [...committed, draft].filter(Boolean).join('');
  console.log('\n———— 识别结果 ————');
  console.log(text || '(空)');
  if (truth) {
    console.log('\n———— 参考文本 ————');
    console.log(truth);
    // 只做字符级粗比对：这份 truth 是未经人工核对的 draft（见 PRD R3），
    // 所以它只能用来发现「明显跑偏」，不能用来判定字准确率。
    const a = text.replace(/\s/g, '');
    const b = truth.replace(/\s/g, '');
    const same = a.length > 0 && a === b;
    console.log(`\n逐字比对：${same ? '完全一致' : `不一致（识别 ${a.length} 字 / 参考 ${b.length} 字）`}`);
  }

  console.log('\n———— 延迟 ————');
  console.log(formatSummary(summary));
  console.log(`结果落盘：${file}`);
  if (truncated) console.warn('[自测] 未等到 task-finished（被截断），但文本已保留');
  if (errors.length) console.warn(`[自测] 发生 ${errors.length} 次错误`);

  // 逐项对照 PRD §6 的预算。这是自测的核心价值：改了模型、参数或发送节奏，
  // 跑一遍就知道有没有把延迟搞坏，不用每次都靠人开口说话去感受。
  // 注意「快捷键→上屏」这项在没有渲染进程的自测里永远是 null，跳过它。
  const budget = checkBudget(summary);
  console.log('\n———— 对照 PRD §6 预算 ————');
  for (const b of budget.items) {
    console.log(`${b.ok ? ' ok ' : 'FAIL'}  ${b.name}  ${b.value}  预算 ${b.budget}`);
  }
  const ok = errors.length === 0 && budget.ok;

  if (!ok) console.error('\n[自测] 结论：不通过');
  return { ok, summary, text };
}

/** PRD §6 的五行预算（毫秒）。自测里量不到的项不参与判定。 */
const BUDGET = [
  { key: 'hotkeyToBarMs', name: '快捷键 → 悬浮条出现', budget: 100 },
  { key: 'firstWordMs', name: '出声 → 首字上屏', budget: 800 },
  { key: 'followP50Ms', name: '跟随延迟 P50', budget: 250 },
  { key: 'sentenceFinalP50Ms', name: '句尾定稿 P50', budget: 1200 },
  { key: 'stopToCopyableMs', name: '松开 → 可点击复制', budget: 1500 },
];

function checkBudget(summary) {
  const items = [];
  for (const b of BUDGET) {
    const v = summary[b.key];
    // null 表示这项在当前场景量不到（比如无渲染进程时的「快捷键→上屏」），
    // 不参与判定，但要在输出里体现出来，避免误以为它通过了
    if (v === null || v === undefined) {
      items.push({ ...b, value: '量不到', ok: true, skipped: true });
      continue;
    }
    items.push({ ...b, value: `${Math.round(v)} ms`, ok: v <= b.budget });
  }
  return { items, ok: items.every((i) => i.ok) };
}
