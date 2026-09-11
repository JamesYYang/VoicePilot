import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { app } from 'electron';
import { openStore, getMeta } from '../store.js';
import { ConfigEndpointError, fetchRemoteCredentials, readEndpointConfig } from '../config-endpoint.js';
import { bootstrapCredentials, loadCredentials, refreshFromEndpoint } from '../asr/config.js';

/** 起一个只回固定响应的 mock 端点，返回 {url, close}。 */
function startMock(handler) {
  return new Promise((resolve) => {
    const srv = createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${srv.address().port}`,
        // closeAllConnections 必须先踢掉挂起的连接（超时那条用例会留一个），
        // 否则 srv.close 会一直等下去，自测挂死在最后一步。
        close: () =>
          new Promise((r) => {
            srv.closeAllConnections?.();
            srv.close(r);
          }),
      });
    });
  });
}

const json = (status, body) => (_req, res) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

export async function runConfigSelftest() {
  console.log('[自测] Key 端点下发（config-endpoint）');

  // 凭据缓存落在 app.getPath('userData')，自测必须换到临时目录，
  // 否则会覆盖开发机上真实的 credentials.json。
  const dir = mkdtempSync(join(tmpdir(), 'vp-config-selftest-'));
  app.setPath('userData', dir);
  openStore(':memory:');

  // .env 有真 Key 时 bootstrap 会短路，测不到端点路径。
  // Node 的 loadEnvFile 不覆盖已存在的 process.env，所以置空即可屏蔽 .env。
  process.env.DASHSCOPE_API_KEY = '';
  process.env.DASHSCOPE_WORKSPACE_ID = '';

  const results = [];
  const check = (name, cond) => results.push([name, cond]);

  // ---- 1. 200 且字段合法 → 写缓存 + 落 config_version ----
  const okMock = await startMock(json(200, { version: 7, apiKey: 'sk-abc', workspaceId: 'ws-1' }));
  const r1 = await refreshFromEndpoint({ endpointConfig: { endpoint: okMock.url, token: 't' } });
  check('200 成功', r1.ok === true && r1.version === 7);
  check('200 落盘', loadCredentials().apiKey === 'sk-abc');
  check('200 记版本', getMeta('config_version') === '7');
  await okMock.close();

  // ---- 2. 401 → unauthorized，不写缓存 ----
  const srv401 = await startMock(json(401, { error: 'unauthorized' }));
  const r2 = await refreshFromEndpoint({ endpointConfig: { endpoint: srv401.url, token: 't' } });
  check('401 归类', r2.ok === false && r2.kind === 'unauthorized');
  check('401 不覆盖缓存', loadCredentials().apiKey === 'sk-abc');
  await srv401.close();

  // ---- 3. 连不上 → network；已有缓存时 loadCredentials 仍返回旧值 ----
  const r3 = await refreshFromEndpoint({ endpointConfig: { endpoint: 'http://127.0.0.1:1', token: 't' } });
  check('连不上归类', r3.ok === false && r3.kind === 'network');
  check('失败仍用缓存', loadCredentials().apiKey === 'sk-abc');

  // ---- 4. 无缓存 + 端点失败 → bootstrap 返回 false，且带 kind ----
  rmSync(join(dir, 'credentials.json'), { force: true });
  const b4 = await bootstrapCredentials({ endpointConfig: { endpoint: 'http://127.0.0.1:1', token: 't' } });
  check('无缓存+失败', b4.ok === false && b4.kind === 'network');

  // ---- 5. 200 但字段不合法 → bad-response，不写缓存 ----
  const badMock = await startMock(json(200, { version: 1, apiKey: 'nope', workspaceId: 'ws-1' }));
  const r5 = await refreshFromEndpoint({ endpointConfig: { endpoint: badMock.url, token: 't' } });
  check('字段不合法归类', r5.ok === false && r5.kind === 'bad-response');
  await badMock.close();

  // ---- 6. 超时注入（mock 不响应）→ network ----
  const hangMock = await startMock(() => {});
  const r6 = await refreshFromEndpoint({
    endpointConfig: { endpoint: hangMock.url, token: 't' },
    timeoutMs: 150,
  });
  check('超时归类', r6.ok === false && r6.kind === 'network');
  await hangMock.close();

  rmSync(dir, { recursive: true, force: true });

  const ok = results.every(([, c]) => c);
  console.log(`[自测] ${ok ? '通过' : '失败'} ${results.map(([n, c]) => `${n}=${c}`).join(' ')}`);
  return { ok };
}
