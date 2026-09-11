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

/** 统一 JSON 响应；凭据响应必须禁缓存，防止内网代理把 apiKey 缓存下来。 */
function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

/** 请求处理器。抽成工厂是为了让自测能直接复用，不必起 TLS。 */
export function createRequestHandler({ token, apiKey, workspaceId, version }) {
  return (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // 契约是 GET /config：其他方法一律并入 404，保持响应面只有 200/401/404（不引入 405）。
    if (req.method !== 'GET' || url.pathname !== '/config') {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    if (req.headers['x-vp-token'] !== token) {
      // 401 不携带任何凭据线索
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    sendJson(res, 200, { version, apiKey, workspaceId });
  };
}

/**
 * 读取并校验环境变量。**无副作用**：不打印、不退出，因此自测可在进程内直接调用。
 * 成功返回 { ok: true, config }；失败返回 { ok: false, problems }，由调用方决定如何处理。
 */
export function readEnv(env = process.env) {
  const token = (env.VP_CONFIG_TOKEN ?? '').trim();
  const apiKey = (env.VP_DASHSCOPE_API_KEY ?? '').trim();
  const workspaceId = (env.VP_DASHSCOPE_WORKSPACE_ID ?? '').trim();
  const problems = [];
  if (!token) problems.push('缺少 VP_CONFIG_TOKEN');
  if (!apiKey) problems.push('缺少 VP_DASHSCOPE_API_KEY');
  if (!workspaceId) problems.push('缺少 VP_DASHSCOPE_WORKSPACE_ID');

  // 必须显式校验为整数：否则 JSON.stringify 会把 NaN 写成 null，破坏 version:<int> 契约；
  // port 为 NaN 还会让 listen() 抛出未处理的 ERR_SOCKET_BAD_PORT。
  const version = Number(env.VP_CONFIG_VERSION ?? 1);
  if (!Number.isInteger(version)) {
    problems.push(`VP_CONFIG_VERSION 必须是整数：${env.VP_CONFIG_VERSION}`);
  }
  const port = Number(env.VP_PORT ?? 8443);
  if (!Number.isInteger(port)) {
    problems.push(`VP_PORT 必须是整数：${env.VP_PORT}`);
  }

  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    config: {
      token,
      apiKey,
      workspaceId,
      version,
      port,
      tlsCert: env.VP_TLS_CERT,
      tlsKey: env.VP_TLS_KEY,
    },
  };
}

function main() {
  const result = readEnv();
  if (!result.ok) {
    // 跑起来却发不出有效配置，比不跑更糟：打印问题后直接退出。
    console.error(`[config-endpoint] 环境变量有误：${result.problems.join('；')}`);
    process.exit(1);
  }
  const env = result.config;
  const handler = createRequestHandler(env);
  if (env.tlsCert && env.tlsKey) {
    const srv = createHttpsServer(
      { cert: readFileSync(env.tlsCert), key: readFileSync(env.tlsKey) },
      handler,
    );
    srv.listen(env.port, () => {
      console.log(`[config-endpoint] 已启动，端口 ${srv.address().port}（TLS），version=${env.version}`);
    });
  } else {
    // 没给证书就用裸 HTTP，但只绑回环：同机前置网关才可达，明文 Key 不出本机。
    console.warn('[config-endpoint] 未配置 VP_TLS_CERT / VP_TLS_KEY，以裸 HTTP 启动且仅绑定 127.0.0.1（仅同机前置网关可达）');
    const srv = createHttpServer(handler);
    srv.listen(env.port, '127.0.0.1', () => {
      console.log(`[config-endpoint] 已启动，127.0.0.1:${srv.address().port}（明文回退，仅本机可达），version=${env.version}`);
    });
  }
}

// 仅在被直接执行时起服务；被 import 时不产生副作用（test.mjs 依赖这点）
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
