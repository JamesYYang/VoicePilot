import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { app } from 'electron';
import { openStore, getMeta } from '../store.js';
import { bootstrapCredentials, loadCredentials, refreshFromEndpoint } from '../asr/config.js';

/**
 * 起一个只回固定响应的 mock 端点，返回 {url, port, close}。
 * host 传 null 时不指定绑定地址（监听所有回环），供 localhost 用例使用——
 * 只绑 127.0.0.1 时 `localhost` 若解析到 ::1 会连不上，导致用例假红。
 */
function startMock(handler, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = createServer(handler);
    const onListen = () =>
      resolve({
        url: `http://127.0.0.1:${srv.address().port}`,
        port: srv.address().port,
        // closeAllConnections 必须先踢掉挂起的连接（超时那条用例会留一个），
        // 否则 srv.close 会一直等下去，自测挂死在最后一步。
        close: () =>
          new Promise((r) => {
            srv.closeAllConnections?.();
            srv.close(r);
          }),
      });
    if (host) srv.listen(0, host, onListen);
    else srv.listen(0, onListen);
  });
}

/**
 * 造一个 mock 处理器：先校验请求形状（方法 GET、路径 /config、X-VP-Token 匹配），
 * 任一不符直接回 400。这样「方法不是 GET」「路径不是 /config」「请求头缺失/写错」
 * 任一契约回归都会让用例变红，而不是被 mock 无声吞掉。
 */
const respond = (status, rawBody, { token = 't', contentType = 'application/json' } = {}) => (req, res) => {
  const shapeOk = req.method === 'GET' && req.url === '/config' && req.headers['x-vp-token'] === token;
  if (!shapeOk) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad request shape' }));
    return;
  }
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(rawBody);
};

/** 契约端点以 /config 暴露（Task 1 交付），mock 用它拼接完整 URL。 */
const json = (status, body, opts) => respond(status, JSON.stringify(body), opts);

/**
 * 造一个「一旦被调用就记录并抛错」的假 fetch。
 * 用于证明坏端点/缺端点在发请求之前就被拦下——回环外的明文绝不能被尝试。
 */
function makeSpyFetch() {
  const spy = {
    called: false,
    impl: async () => {
      spy.called = true;
      throw new Error('不应发出请求');
    },
  };
  return spy;
}

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
  // endpoint 拼上 /config：mock 会校验路径，走错直接 400。
  const okMock = await startMock(json(200, { version: 7, apiKey: 'sk-abc', workspaceId: 'ws-1' }));
  const r1 = await refreshFromEndpoint({ endpointConfig: { endpoint: `${okMock.url}/config`, token: 't' } });
  check('200 成功', r1.ok === true && r1.version === 7);
  check('200 落盘', loadCredentials().apiKey === 'sk-abc');
  check('200 记版本', getMeta('config_version') === '7');
  await okMock.close();

  // ---- 2. 401 → unauthorized，不写缓存 ----
  const srv401 = await startMock(json(401, { error: 'unauthorized' }));
  const r2 = await refreshFromEndpoint({ endpointConfig: { endpoint: `${srv401.url}/config`, token: 't' } });
  check('401 归类', r2.ok === false && r2.kind === 'unauthorized');
  check('401 不覆盖缓存', loadCredentials().apiKey === 'sk-abc');
  await srv401.close();

  // ---- 3. 连不上 → network；已有缓存时 loadCredentials 仍返回旧值 ----
  const r3 = await refreshFromEndpoint({ endpointConfig: { endpoint: 'http://127.0.0.1:1/config', token: 't' } });
  check('连不上归类', r3.ok === false && r3.kind === 'network');
  check('失败仍用缓存', loadCredentials().apiKey === 'sk-abc');

  // ---- 4. 无缓存 + 端点失败 → bootstrap 返回 false，且带 kind ----
  rmSync(join(dir, 'credentials.json'), { force: true });
  const b4 = await bootstrapCredentials({ endpointConfig: { endpoint: 'http://127.0.0.1:1/config', token: 't' } });
  check('无缓存+失败', b4.ok === false && b4.kind === 'network');

  // ---- 5. 200 但字段不合法 → bad-response，不写缓存 ----
  const badMock = await startMock(json(200, { version: 1, apiKey: 'nope', workspaceId: 'ws-1' }));
  const r5 = await refreshFromEndpoint({ endpointConfig: { endpoint: `${badMock.url}/config`, token: 't' } });
  check('字段不合法归类', r5.ok === false && r5.kind === 'bad-response');
  await badMock.close();

  // ---- 6. 超时注入（mock 不响应）→ network ----
  const hangMock = await startMock(() => {});
  const r6 = await refreshFromEndpoint({
    endpointConfig: { endpoint: `${hangMock.url}/config`, token: 't' },
    timeoutMs: 150,
  });
  check('超时归类', r6.ok === false && r6.kind === 'network');
  await hangMock.close();

  // ---- 7. 核心安全不变量：http 非回环 → bad-response，且根本不发请求 ----
  // 注入 spy fetch：若 isAllowedScheme 放宽到「任意 http」，spy 会被调用、用例变红；
  // 同时确保坏端点绝不会把 Key 明文发向回环之外。
  const spy7 = makeSpyFetch();
  const r7 = await refreshFromEndpoint({
    endpointConfig: { endpoint: 'http://10.0.0.1/config', token: 't' },
    fetchImpl: spy7.impl,
  });
  check('非回环 http 归类', r7.ok === false && r7.kind === 'bad-response');
  check('非回环 http 不发请求', spy7.called === false);

  // ---- 8. 端点配置缺失 → bad-response，且不发请求 ----
  const spy8 = makeSpyFetch();
  const r8 = await refreshFromEndpoint({ endpointConfig: null, fetchImpl: spy8.impl });
  check('缺端点配置归类', r8.ok === false && r8.kind === 'bad-response');
  check('缺端点配置不发请求', spy8.called === false);

  // ---- 9. mock 返回 404 → bad-response ----
  const srv404 = await startMock(json(404, { error: 'not_found' }));
  const r9 = await refreshFromEndpoint({ endpointConfig: { endpoint: `${srv404.url}/config`, token: 't' } });
  check('404 归类', r9.ok === false && r9.kind === 'bad-response');
  await srv404.close();

  // ---- 10. mock 返回 500 → bad-response ----
  const srv500 = await startMock(json(500, { error: 'boom' }));
  const r10 = await refreshFromEndpoint({ endpointConfig: { endpoint: `${srv500.url}/config`, token: 't' } });
  check('500 归类', r10.ok === false && r10.kind === 'bad-response');
  await srv500.close();

  // ---- 11. 200 但 body 不是合法 JSON → bad-response ----
  const notJsonMock = await startMock(respond(200, 'not json', { contentType: 'text/plain' }));
  const r11 = await refreshFromEndpoint({ endpointConfig: { endpoint: `${notJsonMock.url}/config`, token: 't' } });
  check('非 JSON 归类', r11.ok === false && r11.kind === 'bad-response');
  await notJsonMock.close();

  // ---- 12. 成功分支（核心设计行为）：有缓存 → 立刻返回 source:'cache'，不 await 端点 ----
  // 先用一次成功刷新把缓存写进去。
  const seedMock = await startMock(json(200, { version: 9, apiKey: 'sk-cache', workspaceId: 'ws-c' }));
  await refreshFromEndpoint({ endpointConfig: { endpoint: `${seedMock.url}/config`, token: 't' } });
  await seedMock.close();
  // 再拿一个**永不响应**的端点调 bootstrap：若它 await 了端点，3s 超时前绝不会返回。
  const cacheHang = await startMock(() => {});
  const cacheT0 = Date.now();
  const b12 = await bootstrapCredentials({
    endpointConfig: { endpoint: `${cacheHang.url}/config`, token: 't' },
    timeoutMs: 3000,
  });
  const cacheElapsed = Date.now() - cacheT0;
  check('缓存命中成功', b12.ok === true && b12.source === 'cache');
  check('缓存不阻塞启动', cacheElapsed < 500);
  // 后台那次刷新仍挂在 cacheHang 上，不 kick 掉连接会挂死。
  await cacheHang.close();

  // ---- 13. 成功分支：环境变量命中 → source:'env'，根本不碰端点 ----
  // 用例直接设置 process.env，不依赖仓库根存在 .env：loadDevEnv 在 .env 缺失时
  // 也会用 process.env 求值，故新克隆/CI 上同样成立。
  process.env.DASHSCOPE_API_KEY = 'sk-env-dummy';
  process.env.DASHSCOPE_WORKSPACE_ID = 'ws-env';
  const spy13 = makeSpyFetch();
  const b13 = await bootstrapCredentials({
    endpointConfig: { endpoint: 'http://127.0.0.1:1/config', token: 't' },
    fetchImpl: spy13.impl,
  });
  check('.env 命中来源', b13.ok === true && b13.source === 'env');
  check('.env 命中不碰端点', spy13.called === false);
  // 恢复本文件原有的屏蔽状态（.env 真值不得泄漏进后续用例）。
  process.env.DASHSCOPE_API_KEY = '';
  process.env.DASHSCOPE_WORKSPACE_ID = '';

  // ---- 14. isAllowedScheme 的 localhost 分支：http://localhost 回环应被放行 ----
  // 现有用例只覆盖 127.0.0.1 与「非回环 http 被拒」，删掉 localhost 子分支不会变红。
  const localMock = await startMock(
    json(200, { version: 1, apiKey: 'sk-local', workspaceId: 'ws-l' }),
    null
  );
  const r14 = await refreshFromEndpoint({
    endpointConfig: { endpoint: `http://localhost:${localMock.port}/config`, token: 't' },
  });
  check('localhost 放行', r14.ok === true);
  await localMock.close();

  rmSync(dir, { recursive: true, force: true });

  const ok = results.every(([, c]) => c);
  console.log(`[自测] ${ok ? '通过' : '失败'} ${results.map(([n, c]) => `${n}=${c}`).join(' ')}`);
  return { ok };
}
