import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamingAsr } from './lib/asr.js';
import { readWav, sleep } from './lib/wav.js';

/**
 * 百炼 RPM 限流压测 —— 对应 PRD §9 风险 R8，是 M1 的准出硬条件。
 *
 * 要回答两个问题：
 *   ① 计数口径：限流是按 duplex 流里的每个音频帧计，还是只按 run-task 计？
 *   ② 实际阈值是多少，够不够支撑 50 人内部试用（未必所有人同时说话）？
 *
 * 判别方法：并发 N 路跑满一分钟，看折算帧速率与失败情况。按 run-task 计的话
 * 几十路并发也只有几十次请求，绝无可能触发限流——所以一旦出现 Throttling，
 * 就说明帧是被计数的。
 *
 * ── 2026-09-05 实测（--ramp 3,10,30 --seconds 60）──────────────────────
 *
 *   并发  3 → 折算  1677 次/分钟   全通过
 *   并发 10 → 折算  5587 次/分钟   全通过          ← 关键
 *   并发 30 → 折算 12832 次/分钟   9/30 被拒
 *
 *   ① 帧确实被计数（30 次 run-task 不可能触发限流）
 *   ② 但**阈值远高于官方文档标注的 1200 RPM** —— 5587 次/分钟仍全通过。
 *      文档那个 1200 不能当容量规划依据，别再拿它做算术
 * 补测（--ramp 15,20,25 --seconds 45 --keep-going）把阈值框死：
 *
 *   并发 15 → 折算  8323 次/分钟   全通过
 *   并发 20 → 折算 11054 次/分钟   全通过
 *   并发 25 → 折算  9909 次/分钟   5/25 被拒（仅 20 路成功）
 *
 *   ③ **上限就是 20 路并发**，折算约 12000 次/分钟 ≈ 200 QPS。
 *      25 路时恰好只剩 20 路成功，与 30 路时的 21 路互相印证。
 *
 * 参考：单人说话占 600 次/分钟（100ms 合批 = 10 帧/秒）。阈值是它的 20 倍，
 * 所以 50 人共用 Key 可行 —— 不会所有人同时说话。但客户端必须处理 Throttling：
 * 退避重试 + 明确提示，否则表现是「说话没反应」，用户无法归因。
 *
 * 用法：
 *   npm run rpm
 *   npm run rpm -- --ramp 3 --seconds 60          # 只跑判别档
 *   npm run rpm -- --ramp 3,10,30 --seconds 60    # 默认
 *   npm run rpm -- --keep-going                   # 触发限流后继续跑完
 */

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- 参数

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const RAMP = arg('ramp', '3,10,30')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);

const SECONDS = Number(arg('seconds', 60));
const AUDIO = arg('audio', join(HERE, 'audio', '03-mixed-16k.wav'));
const KEEP_GOING = args.includes('--keep-going');

// 100ms × 16kHz × 16bit × 1声道 = 3200 字节，百炼官方对新模型的示例值
const CHUNK_BYTES = 3200;
const FRAMES = Math.round(SECONDS * 10);

// 单人说话的占用量：100ms 合批 → 10 帧/秒 → 600 次/分钟
const PER_USER_RPM = 600;

// 百炼的限流/流控错误码形如 Throttling.RateQuota，网关层可能表现为 429 或
// TooManyRequests。这里用宽匹配，宁可误报。
const THROTTLE_RE =
  /throttl|429|too\s*many|限流|流控|流量控制|FlowLimit|quota|QPS|TPS|RequestLimit|SystemBusy/i;

// ---------------------------------------------------------------- 凭证

const apiKey = process.env.DASHSCOPE_API_KEY;
const workspaceId = process.env.DASHSCOPE_WORKSPACE_ID;

if (!apiKey || !workspaceId) {
  console.error('凭证未填全。请在 .env 中填写 DASHSCOPE_API_KEY 与 DASHSCOPE_WORKSPACE_ID');
  process.exit(1);
}

if (!existsSync(AUDIO)) {
  console.error(`找不到音频文件: ${AUDIO}`);
  console.error('可用素材见 spike/audio/（*-16k.wav 已转码为 16kHz 单声道）');
  process.exit(1);
}

// ---------------------------------------------------------------- 素材

const { pcm, durationMs } = readWav(AUDIO);

// 切成 3200 字节的帧，最后一帧不足则丢弃（偏差 <100ms，不影响计数口径判断）
const chunks = [];
for (let off = 0; off + CHUNK_BYTES <= pcm.length; off += CHUNK_BYTES) {
  chunks.push(pcm.subarray(off, off + CHUNK_BYTES));
}
if (chunks.length === 0) {
  console.error(`音频太短（${(durationMs / 1000).toFixed(1)}s），不足一帧 ${CHUNK_BYTES} 字节`);
  process.exit(1);
}

// ---------------------------------------------------------------- 单次会话

async function runOne() {
  let error = null;
  let sent = 0;

  const s = new StreamingAsr({
    apiKey,
    workspaceId,
    onResult: () => {}, // 本脚本只关心请求是否被限流，不关心识别内容
    onError: (err) => {
      error = err.message;
    },
  });

  const t0 = Date.now();

  try {
    await s.start();

    for (let i = 0; i < FRAMES && !error; i++) {
      s.sendAudio(chunks[i % chunks.length]);
      sent++;
      await sleep(100);
    }

    // 已经 task-failed 的会话再 stop 必然失败，只在正常时收尾
    if (!error) await s.stop();
  } catch (err) {
    error = err.message;
  }

  return { ok: !error, error, sent, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------- 逐档压测

const totalAudioSec = RAMP.reduce((a, n) => a + n, 0) * SECONDS;

console.log('');
console.log('百炼 RPM 限流压测（PRD §9 R8）');
console.log('');
console.log(`  Workspace:  ${workspaceId}`);
console.log(`  素材:       ${AUDIO.split(/[\\/]/).pop()}（${(durationMs / 1000).toFixed(1)}s，循环播放）`);
console.log(`  并发档位:   ${RAMP.join(' → ')}`);
console.log(`  每档时长:   ${SECONDS}s（${FRAMES} 帧 × ${CHUNK_BYTES} 字节）`);
console.log(`  预计费用:   ${(totalAudioSec * 0.00033).toFixed(2)} 元（0.00033 元/秒，静音也计费）`);
console.log('');

const rows = [];

for (const n of RAMP) {
  process.stdout.write(`并发 ${String(n).padStart(2)} 路 … `);

  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: n }, runOne));
  const wallSec = (Date.now() - t0) / 1000;

  const failed = results.filter((r) => !r.ok);
  const throttled = failed.filter((r) => THROTTLE_RE.test(r.error ?? ''));
  const frames = results.reduce((a, r) => a + r.sent, 0);
  const rpm = frames / (wallSec / 60);

  const row = {
    n,
    wallSec,
    frames,
    rpm,
    failed: failed.length,
    throttleCount: throttled.length,
    errors: failed.map((f) => f.error),
  };
  rows.push(row);

  const status =
    throttled.length > 0 ? `❌ 限流 ${throttled.length}/${n}`
    : failed.length > 0 ? `⚠️  失败 ${failed.length}/${n}（非限流）`
    : '✅ 全通过';

  console.log(`${status}   帧 ${String(frames).padStart(5)}   折算 ${String(Math.round(rpm)).padStart(5)} 次/分钟`);

  if (failed.length > 0) {
    for (const e of [...new Set(row.errors)].slice(0, 3)) {
      console.log(`             ↳ ${e}`);
    }
  }

  if (throttled.length > 0 && !KEEP_GOING) {
    console.log('');
    console.log('（已触发限流，停止后续档位。加 --keep-going 可继续）');
    break;
  }
}

// ---------------------------------------------------------------- 结论

function conclude() {
  const bad = rows.find((r) => r.throttleCount > 0);

  // 全部通过的档位里，折算速率最高的那一档
  const passed = rows.filter((r) => r.throttleCount === 0);
  const best = passed.length ? passed.reduce((a, r) => (r.rpm > a.rpm ? r : a)) : null;

  if (bad) {
    const ok = bad.n - bad.throttleCount;

    const lines = [
      `❌ 触发限流：并发 ${bad.n} 路时 ${bad.throttleCount}/${bad.n} 路被拒。`,
      '',
      `   帧确实被计数 —— 这一档只有 ${bad.n} 次 run-task，按任务计绝无可能触发限流。`,
      '',
      '   但阈值远高于官方文档标注的 1200 RPM：',
    ];

    if (best) {
      lines.push(
        `     并发 ${String(best.n).padStart(2)}（≈ ${best.n} 人同时说话）折算 ${String(Math.round(best.rpm)).padStart(5)} 次/分钟 → 全通过`,
        `     并发 ${String(bad.n).padStart(2)}（≈ ${bad.n} 人）折算 ${String(Math.round(bad.rpm)).padStart(5)} 次/分钟 → ${ok} 通过 / ${bad.throttleCount} 被拒`,
      );
    }

    lines.push(
      '',
      !best
        ? `   → ${bad.n} 人并发时 ${ok} 路成功，上限约 ${ok} 人。`
        : best.n === ok
          ? `   → 已验证支撑 ${best.n} 人同时说话；${bad.n} 人时仍只有 ${ok} 路成功 —— 上限就是 ${ok} 人。`
          : `   → 已验证支撑 ${best.n} 人；${bad.n} 人时 ${ok} 路成功，上限约在 ${best.n}–${ok} 人之间。`,
      '   → 文档标注的 1200 RPM 与实测不符，不能拿它做容量规划。',
      '',
      '   对 50 人内部试用的判断：',
      '     同时说话的人数通常远低于总人数，上述余量基本够用，共用 Key 可行。',
      '     但客户端必须处理服务端限流：收到 Throttling 时退避重试并明确提示，',
      '     不能静默失败 —— 静默失败的表现是「说话没反应」，用户无法归因。',
      '',
      `   若要在不同 Key 或不同模型上复测：npm run rpm -- --ramp 20,25 --seconds 45`,
    );

    return lines.join('\n');
  }

  const top = rows[rows.length - 1];

  // 折算值必须超过 1200 才有判别力。没超过这个数，「帧不计入」与
  // 「帧计入但还没到阈值」两种情况无法区分，不能下肯定结论。
  if (top.rpm <= 1200) {
    return [
      '⚠️  未触发限流，但判别力不足，无法定案。',
      '',
      `   最高只跑到 ${Math.round(top.rpm)} 次/分钟，未超过文档标注的 1200，`,
      '   因此区分不了「帧不计入」与「帧计入但还没到阈值」两种情况。',
      '',
      '   提高并发或时长再跑：npm run rpm -- --ramp 10,30 --seconds 60',
    ].join('\n');
  }

  return [
    '✅ 未触发限流。',
    '',
    `   最高跑到并发 ${top.n} 路、折算 ${Math.round(top.rpm)} 次/分钟`,
    `   （≈ ${Math.round(top.rpm / PER_USER_RPM)} 人同时说话），全部通过。`,
    '   已远超文档标注的 1200 RPM 而未受限，说明真实阈值要高得多。',
    '',
    '   50 人共用 Key 可行。服务端代理可继续推迟到对外发布时配合 SmartRouter 一起做。',
  ].join('\n');
}

const spentSec = rows.reduce((a, r) => a + r.frames * 0.1, 0);

console.log('');
console.log('─'.repeat(72));
console.log(conclude());
console.log('─'.repeat(72));
console.log('');
console.log(`实际跑量：音频 ${spentSec.toFixed(0)} 秒，费用约 ${(spentSec * 0.00033).toFixed(2)} 元`);
console.log('');
