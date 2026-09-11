import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 客户端唯一的「拿 token 换凭据」模块。
 *
 * 刻意不依赖 electron：只读一个 JSON、发一次 HTTP，因此可以在
 * Electron 之外被直接测试，将来 F11 全套或登录体系落地时整块替换掉。
 *
 * 访问控制的主控制是内网边界（见 spec §0），token 是第二道。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/** 打包时注入的真值文件（gitignore）；开发模式不读它，.env 优先。 */
const BUILT_PATH = join(HERE, 'endpoint.built.json');
const DEFAULT_TIMEOUT_MS = 3000;

export class ConfigEndpointError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'ConfigEndpointError';
    this.kind = kind; // 'network' | 'unauthorized' | 'bad-response'
  }
}

/** 读端点配置。缺失或字段不合法返回 null（不抛，由调用方归一成 bad-response）。 */
export function readEndpointConfig(path = BUILT_PATH) {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    const endpoint = String(j.endpoint ?? '').trim();
    const token = String(j.token ?? '').trim();
    if (!endpoint || !token) return null;
    return { endpoint, token };
  } catch {
    return null;
  }
}

/**
 * 只放行 https。自测在本机回环上跑，那个例外必须写死在这里——
 * 否则任何人手改 endpoint.built.json 成 http 就能让 Key 明文过网。
 */
function isAllowedScheme(endpoint) {
  try {
    const u = new URL(endpoint);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  } catch {
    return false;
  }
}

/** 拿 token 换凭据。成功 → {apiKey, workspaceId, version}；失败抛 ConfigEndpointError。 */
export async function fetchRemoteCredentials({
  config,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  if (!config) throw new ConfigEndpointError('bad-response', '未配置端点（endpoint.built.json 缺失或字段不全）');
  if (!isAllowedScheme(config.endpoint)) {
    throw new ConfigEndpointError('bad-response', `端点必须使用 https：${config.endpoint}`);
  }

  let res;
  try {
    res = await fetchImpl(config.endpoint, {
      headers: { 'X-VP-Token': config.token },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // 超时、DNS、连接失败、证书失败都归这里
    throw new ConfigEndpointError('network', e?.message ?? String(e));
  }

  if (res.status === 401) throw new ConfigEndpointError('unauthorized', 'HTTP 401');
  if (!res.ok) throw new ConfigEndpointError('bad-response', `HTTP ${res.status}`);

  let j;
  try {
    j = await res.json();
  } catch {
    throw new ConfigEndpointError('bad-response', '响应不是合法 JSON');
  }

  const apiKey = String(j?.apiKey ?? '').trim();
  const workspaceId = String(j?.workspaceId ?? '').trim();
  const version = Number(j?.version);
  if (!apiKey.startsWith('sk-') || !workspaceId) {
    throw new ConfigEndpointError('bad-response', '响应字段不合法');
  }
  if (!Number.isFinite(version)) throw new ConfigEndpointError('bad-response', 'version 字段不合法');

  return { apiKey, workspaceId, version };
}
