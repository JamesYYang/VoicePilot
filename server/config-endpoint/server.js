import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * VoicePilot 配置端点（F11 最小版）。
 *
 * 唯一职责：拿 token 换回 DashScope 凭据。没有数据库、没有管理界面——
 * 3~5 人试用不配拥有它们。Key 从自己的环境变量读，不落盘。
 *
 * 访问控制的主控制是**内网边界**，token 是第二道（见 spec §0）。
 */

/** 请求处理器。抽成工厂是为了让自测能直接复用，不必起 TLS。 */
export function createRequestHandler({ token, apiKey, workspaceId, version }) {
  return (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/config') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    if (req.headers['x-vp-token'] !== token) {
      // 401 不携带任何凭据线索
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version, apiKey, workspaceId }));
  };
}

/** 缺任何一项就直接退出：跑起来却发不出有效配置，比不跑更糟。 */
function readEnv() {
  const token = (process.env.VP_CONFIG_TOKEN ?? '').trim();
  const apiKey = (process.env.VP_DASHSCOPE_API_KEY ?? '').trim();
  const workspaceId = (process.env.VP_DASHSCOPE_WORKSPACE_ID ?? '').trim();
  const missing = [];
  if (!token) missing.push('VP_CONFIG_TOKEN');
  if (!apiKey) missing.push('VP_DASHSCOPE_API_KEY');
  if (!workspaceId) missing.push('VP_DASHSCOPE_WORKSPACE_ID');
  if (missing.length) {
    console.error(`[config-endpoint] 缺少环境变量：${missing.join(', ')}`);
    process.exit(1);
  }
  return {
    token,
    apiKey,
    workspaceId,
    version: Number(process.env.VP_CONFIG_VERSION ?? 1),
    port: Number(process.env.VP_PORT ?? 8443),
    tlsCert: process.env.VP_TLS_CERT,
    tlsKey: process.env.VP_TLS_KEY,
  };
}

function main() {
  const env = readEnv();
  const handler = createRequestHandler(env);
  let srv;
  if (env.tlsCert && env.tlsKey) {
    srv = createHttpsServer({ cert: readFileSync(env.tlsCert), key: readFileSync(env.tlsKey) }, handler);
  } else {
    // 没给证书就用裸 HTTP —— 只允许内网回环 + 前置网关的场景，日志必须吼出来。
    console.warn('[config-endpoint] 未配置 VP_TLS_CERT / VP_TLS_KEY，以裸 HTTP 启动（仅供内网网关前置时使用）');
    srv = createHttpServer(handler);
  }
  srv.listen(env.port, () => {
    console.log(`[config-endpoint] 已启动，端口 ${env.port}，version=${env.version}`);
  });
}

// 仅在被直接执行时起服务；被 import 时不产生副作用（test.mjs 依赖这点）
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
