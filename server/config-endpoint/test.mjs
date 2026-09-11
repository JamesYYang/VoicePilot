import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { createRequestHandler } from './server.js';

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

// 1. token 正确 → 200 + 三个字段
const ok = await get('/config', { 'X-VP-Token': 'test-token' });
assert.equal(ok.status, 200);
assert.deepEqual(await ok.json(), { version: 7, apiKey: 'sk-test-key', workspaceId: 'ws-test' });

// 2. token 错误 → 401，且不返回任何凭据
const bad = await get('/config', { 'X-VP-Token': 'wrong' });
assert.equal(bad.status, 401);
assert.deepEqual(await bad.json(), { error: 'unauthorized' });

// 3. 缺 token → 401
const none = await get('/config');
assert.equal(none.status, 401);

// 4. 其他路径 → 404
const nf = await get('/other', { 'X-VP-Token': 'test-token' });
assert.equal(nf.status, 404);
assert.deepEqual(await nf.json(), { error: 'not_found' });

// fetch 默认 keep-alive，close() 不会销毁空闲 socket，必须先销毁再等回调，否则进程挂死。
srv.closeAllConnections?.();
await new Promise((r) => srv.close(r));
console.log('[服务端自测] 通过：200 / 401 / 缺 token / 404');
