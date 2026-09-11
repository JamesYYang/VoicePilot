import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { createRequestHandler, readEnv } from './server.js';

const handler = createRequestHandler({
  token: 'test-token',
  apiKey: 'sk-test-key',
  workspaceId: 'ws-test',
  version: 7,
});

const srv = createServer(handler);
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

const get = (path, headers = {}) => fetch(`${base}${path}`, { headers });

// 1. token 正确 → 200 + 三个字段 + 禁缓存
const ok = await get('/config', { 'X-VP-Token': 'test-token' });
assert.equal(ok.status, 200);
assert.equal(ok.headers.get('cache-control'), 'no-store');
assert.deepEqual(await ok.json(), { version: 7, apiKey: 'sk-test-key', workspaceId: 'ws-test' });

// 2. token 错误 → 401，且不返回任何凭据
const bad = await get('/config', { 'X-VP-Token': 'wrong' });
assert.equal(bad.status, 401);
assert.deepEqual(await bad.json(), { error: 'unauthorized' });

// 3. 缺 token → 401，且不返回任何凭据（与上面 401 同等断言强度）
const none = await get('/config');
assert.equal(none.status, 401);
assert.deepEqual(await none.json(), { error: 'unauthorized' });

// 4. 其他路径 → 404
const nf = await get('/other', { 'X-VP-Token': 'test-token' });
assert.equal(nf.status, 404);
assert.deepEqual(await nf.json(), { error: 'not_found' });

// 5. 非 GET 方法 → 404（契约是 GET /config，不引入 405）
const post = await fetch(`${base}/config`, {
  method: 'POST',
  headers: { 'X-VP-Token': 'test-token' },
});
assert.equal(post.status, 404);
assert.deepEqual(await post.json(), { error: 'not_found' });

// 6. readEnv 无副作用，可在进程内直接校验
const validEnv = {
  VP_CONFIG_TOKEN: 't',
  VP_DASHSCOPE_API_KEY: 'sk',
  VP_DASHSCOPE_WORKSPACE_ID: 'w',
  VP_CONFIG_VERSION: '7',
  VP_PORT: '9443',
};
const good = readEnv(validEnv);
assert.equal(good.ok, true);
assert.ok(Number.isInteger(good.config.version));
assert.ok(Number.isInteger(good.config.port));
assert.equal(good.config.version, 7);
assert.equal(good.config.port, 9443);

const badVersion = readEnv({ ...validEnv, VP_CONFIG_VERSION: 'garbage' });
assert.equal(badVersion.ok, false);
assert.ok(badVersion.problems.some((p) => p.includes('VP_CONFIG_VERSION')));

const badPort = readEnv({ ...validEnv, VP_PORT: 'garbage' });
assert.equal(badPort.ok, false);
assert.ok(badPort.problems.some((p) => p.includes('VP_PORT')));

// fetch 默认 keep-alive，close() 不会销毁空闲 socket，必须先销毁再等回调，否则进程挂死。
srv.closeAllConnections?.();
await new Promise((r) => srv.close(r));
console.log('[服务端自测] 通过：200 / 401（错+缺）/ 404（路径+方法）/ 禁缓存 / readEnv 校验');
