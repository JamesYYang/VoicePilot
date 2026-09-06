import { app } from 'electron';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ASR 凭据的加载。M2 阶段的唯一来源：仓库根的 .env。
 *
 * ⚠️ 这是**开发期**做法，不是最终形态。
 * PRD §5.8 要求 Key 不内置在安装包里，改由配置端点下发（F11，属于 M5）。
 * 本文件就是将来换配置端点时的**唯一改动点**。
 *
 * 打包后禁止走这条路：一是 .env 不会跟着进 asar，二是就算有人手工塞进去，
 * 也等于把 Key 明文写进可解包的安装包 —— 那正是 §5.8 要避免的。
 * 与其静默失败，不如在这里明确抛错，让问题在开发期就暴露。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// app/electron/asr/config.js → 上三级是仓库根
const ENV_PATH = resolve(HERE, '..', '..', '..', '.env');

/**
 * @returns {{apiKey: string, workspaceId: string}}
 * @throws 打包环境下必然抛错；开发环境下 .env 缺失或字段不全时抛错
 */
export function loadCredentials() {
  if (app.isPackaged) {
    throw new Error(
      '打包版本禁止从 .env 读取密钥。按 PRD §5.8，Key 应由配置端点下发（F11 / M5）。'
    );
  }

  try {
    // Node 20.12+。Electron 44 内置 Node 22，可用。
    // 注意：已存在于 process.env 的同名变量不会被覆盖，这是我们要的行为 ——
    // 真机上想临时换 key，直接在终端里 export 即可，不必改文件。
    process.loadEnvFile(ENV_PATH);
  } catch (e) {
    if (e?.code === 'ENOENT') {
      throw new Error(`找不到密钥文件 ${ENV_PATH}（该文件已被 .gitignore 忽略，不会入库）`);
    }
    throw e;
  }

  const apiKey = process.env.DASHSCOPE_API_KEY;
  const workspaceId = process.env.DASHSCOPE_WORKSPACE_ID;

  if (!apiKey || !workspaceId) {
    const missing = [!apiKey && 'DASHSCOPE_API_KEY', !workspaceId && 'DASHSCOPE_WORKSPACE_ID']
      .filter(Boolean)
      .join(' / ');
    throw new Error(`${ENV_PATH} 里缺少 ${missing}`);
  }

  // 返回值只在主进程内使用，绝不能经 IPC 送到渲染进程（PRD §5.8）。
  return { apiKey, workspaceId };
}

/**
 * run-task 的 parameters。取值与 spike/probe.js 的基线一致，
 * 否则 M2 测出的延迟与准确率无法和 2026-09-04 的离线数据对比。
 *
 * 刻意**不传** max_sentence_silence：保持服务端默认 1300。
 * PRD §5.3 的理由是实测改 400 只快 5%，但 3/3 出现末尾幻觉，幻觉是致命缺陷。
 * （spike/probe.js 里那句「建议传 400」的注释已过时，以 PRD 为准。）
 *
 * inverse_text_normalization_enabled 必须显式传 true：ITN 负责把「百分之二十」
 * 这类口语转成「20%」，是「出口成章」的命门，不能指望服务端默认值。
 */
export const ASR_PARAMETERS = {
  format: 'pcm',
  sample_rate: 16000,
  semantic_punctuation_enabled: false,
  inverse_text_normalization_enabled: true,
  punctuation_prediction_enabled: true,
  disfluency_removal_enabled: false,
};

export const ASR_MODEL = 'qwen-audio-3.0-asr-flash-streaming';
