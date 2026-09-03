import { basename, dirname, join } from 'node:path';
import { readWav, normalizeToAsrInput, writeWav } from './lib/wav.js';

/**
 * 把录音转成 probe 要求的 16kHz / 16bit / 单声道。
 *
 * 存在的意义：Windows 录音机默认出 48kHz 立体声，手机是 m4a，都不能直接
 * 喂给 probe —— 按错误采样率回放会让音频变慢，所有延迟测量失效。
 *
 * 用法: node spike/normalize.js spike/audio/01-dictation.wav [输出路径]
 */

const input = process.argv[2];
if (!input) {
  console.error('用法: node spike/normalize.js <输入.wav> [输出.wav]');
  process.exit(1);
}

const output = process.argv[3] ?? join(dirname(input), `${basename(input, '.wav')}-16k.wav`);

const src = readWav(input, { strict: false });

console.log(`输入: ${basename(input)}`);
console.log(`  ${src.sampleRate}Hz / ${src.channels}声道 / ${src.bitsPerSample}bit  时长 ${(src.durationMs / 1000).toFixed(1)}s`);
if (src.problems) {
  for (const p of src.problems) console.log(`  ⚠ ${p}`);
}

const { pcm, quality } = normalizeToAsrInput(src.pcm, src);
const outDuration = (pcm.length / 2 / 16000) * 1000;

writeWav(output, pcm);

console.log(`输出: ${basename(output)}`);
console.log(`  16000Hz / 1声道 / 16bit  时长 ${(outDuration / 1000).toFixed(1)}s`);

if (quality === 'exact-decimation') {
  console.log('\n降采样: 整数倍抽取（含抗混叠移动平均），质量无损可忽略');
} else if (quality === 'interpolated') {
  console.log('\n降采样: 非整数倍，使用线性插值 —— 有轻微高频损失。');
  console.log('       若要精确的 CER 数据，建议改用 ffmpeg 的 SoX 重采样器：');
  console.log(`       ffmpeg -i "${input}" -ar 16000 -ac 1 -c:a pcm_s16le "${output}"`);
} else {
  console.log('\n降采样: 无需处理（原本就是 16kHz）');
}

// Windows 路径用正斜杠输出，避免在 bash 里被当成转义符
const p = output.replace(/\\/g, '/');
console.log(`\n接下来: npm run probe -- --audio "${p}" --truth "${p.replace(/\.wav$/i, '.txt')}"`);
