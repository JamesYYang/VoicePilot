import { app, safeStorage } from 'electron';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * ASR 凭据的加载与保存。
 *
 * 来源优先级：
 *   1. 开发期：仓库根的 .env（保持现有开发流程不变）
 *   2. 持久化：userData/credentials.json（Key 经 safeStorage 加密，workspaceId 明文）
 *
 * PRD §5.8：Key 最终应由配置端点下发（F11 / M5）。在那之前，打包版通过
 * 「启动时无 Key 则弹窗输入」的方式获取（见 key-entry 窗口），落盘用 safeStorage
 * （Windows DPAPI / macOS Keychain）。将来 F11 落地后，loadCredentials 优先读
 * 配置端点，这里退居兜底 —— 弹窗自然不会再出现。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// app/electron/asr/config.js → 上三级是仓库根
const ENV_PATH = resolve(HERE, '..', '..', '..', '.env');

function keyFilePath() {
  return join(app.getPath('userData'), 'credentials.json');
}

/** 开发期：从仓库根 .env 读。打包版禁走这条路；不存在或字段不全返回 null。 */
function loadDevEnv() {
  if (app.isPackaged) return null;
  try {
    // Node 20.12+。Electron 44 内置 Node 22，可用。
    // 已存在于 process.env 的同名变量不会被覆盖 —— 真机临时换 key 直接 export 即可。
    process.loadEnvFile(ENV_PATH);
  } catch {
    return null;
  }
  const apiKey = process.env.DASHSCOPE_API_KEY;
  const workspaceId = process.env.DASHSCOPE_WORKSPACE_ID;
  if (!apiKey || !workspaceId) return null;
  return { apiKey, workspaceId };
}

/** 持久化：从 userData/credentials.json 读（safeStorage 加密）。失败返回 null。 */
function loadStored() {
  try {
    const j = JSON.parse(readFileSync(keyFilePath(), 'utf8'));
    const apiKey = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(j.apiKey, 'base64'))
      : j.apiKey; // 加密不可用的极少数环境（如无 keyring 的 Linux）明文兜底
    const workspaceId = j.workspaceId;
    if (!apiKey || !workspaceId) return null;
    return { apiKey, workspaceId };
  } catch {
    return null;
  }
}

/** 是否有可用凭据（.env 或持久化 store）。用于启动时决定要不要弹输入窗。 */
export function hasCredentials() {
  return !!(loadDevEnv() ?? loadStored());
}

/** 保存凭据到 userData。Key 经 safeStorage 加密，workspaceId 不敏感、明文存。 */
export function saveCredentials({ apiKey, workspaceId }) {
  const encrypted = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(apiKey).toString('base64')
    : apiKey;
  writeFileSync(keyFilePath(), JSON.stringify({ apiKey: encrypted, workspaceId }), 'utf8');
}

/**
 * @returns {{apiKey: string, workspaceId: string}}
 * @throws 无凭据时抛错——由调用方收敛为明确提示
 */
export function loadCredentials() {
  const dev = loadDevEnv();
  if (dev) return dev;
  const stored = loadStored();
  if (stored) return stored;
  throw new Error('未配置 API Key，请通过托盘菜单「设置 API Key」填入');
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
