# Key 端点下发 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 客户端不再由人工分发 DashScope Key，改为运行时从公司内网 HTTPS 端点取回；附一个最小服务端。

**Architecture:** 纯客户端模块 `config-endpoint.js`（不依赖 electron，只读配置文件 + 发 HTTP）负责「拿 token 换凭据」；`asr/config.js` 负责接线（调用它、把结果经 `safeStorage` 写缓存、把版本号记进 SQLite `meta`）；`main.js` 负责启动时序与用户可见提示。服务端是单文件 Node 原生 `http/https`，无框架无数据库。

**Tech Stack:** Electron 44（内置 Node 24.20.0）、`node:fs` / `node:http` / `node:https`、全局 `fetch` + `AbortSignal.timeout`、Electron `safeStorage` / `dialog`、`node:sqlite`（经既有 `store.js`）。

**Spec:** `docs/superpowers/specs/2026-09-11-key-delivery-design.md`

## Global Constraints

- 端点必须是 `https://`。客户端**自身也校验**，只放行 `https:`（自测用 `http://127.0.0.1:*` 是唯一例外，见 Task 2）。
- 请求超时 **3000ms**；自测可注入更短的值。
- token 与端点地址**不入 git**：真值只存在于 gitignore 的 `app/electron/endpoint.built.json`。
- **不新增任何 npm 依赖**，只用 Node 24 / Electron 44 内置能力。
- 用户可见文案**一律走 i18n 三语**（`zh-CN` / `zh-TW` / `en-US`），不得出现硬编码中文。
- 用户可见提示**统一用 `dialog.showMessageBox`**。
- 自测必须**离线可跑**，不依赖真实端点（本地起 mock server）。
- 不得使用 `rejectUnauthorized: false` 或任何形式的证书校验关闭。
- 路径注意：i18n 实际目录是 **`app/shared/i18n/`**（spec 里简写成 `shared/i18n/*`）。

---

### Task 1: 服务端端点

**Files:**
- Create: `server/config-endpoint/server.js`
- Create: `server/config-endpoint/test.mjs`
- Create: `server/config-endpoint/README.md`

**Interfaces:**
- Consumes: 无（独立子系统）
- Produces: `createRequestHandler({ token, apiKey, workspaceId, version })` → `(req, res) => void`；响应契约为 `GET /config` + `X-VP-Token` → `200 {"version":n,"apiKey":"sk-…","workspaceId":"…"}` / `401 {"error":"unauthorized"}` / `404 {"error":"not_found"}`。Task 5 的 docs 会引用这个契约。

- [ ] **Step 1: 写失败测试 `server/config-endpoint/test.mjs`**

```js
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

srv.close();
console.log('[服务端自测] 通过：200 / 401 / 缺 token / 404');
```

- [ ] **Step 2: 运行确认失败**

Run: `node server/config-endpoint/test.mjs`
Expected: FAIL —— `Cannot find module .../server.js`（或 `createRequestHandler is not a function`）

- [ ] **Step 3: 实现 `server/config-endpoint/server.js`**

```js
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
```

- [ ] **Step 4: 运行确认通过**

Run: `node server/config-endpoint/test.mjs`
Expected: PASS —— 打印 `[服务端自测] 通过：200 / 401 / 缺 token / 404`

- [ ] **Step 5: 写 `server/config-endpoint/README.md`**

````markdown
# 配置端点（F11 最小版）

拿 token 换 DashScope 凭据的内网 HTTPS 端点。设计见
`docs/superpowers/specs/2026-09-11-key-delivery-design.md`。

## 起服务

```bash
export VP_CONFIG_TOKEN='<发给客户端的 token>'
export VP_DASHSCOPE_API_KEY='sk-…'
export VP_DASHSCOPE_WORKSPACE_ID='<业务空间 ID>'
export VP_CONFIG_VERSION=1
export VP_TLS_CERT=/etc/ssl/voicepilot/fullchain.pem
export VP_TLS_KEY=/etc/ssl/voicepilot/privkey.pem
export VP_PORT=8443
node server/config-endpoint/server.js
```

前台验证：

```bash
curl -H "X-VP-Token: $VP_CONFIG_TOKEN" https://<内网域名>/config
# 期望 200 + {"version":1,"apiKey":"sk-…","workspaceId":"…"}
curl https://<内网域名>/config
# 期望 401
```

开机自启（systemd 示例）：

```ini
[Unit]
Description=VoicePilot config endpoint
After=network.target
[Service]
EnvironmentFile=/etc/voicepilot/config-endpoint.env
ExecStart=/usr/bin/node /opt/voicepilot/server/config-endpoint/server.js
Restart=always
[Install]
WantedBy=multi-user.target
```

## 轮换 Key

1. 改 `VP_DASHSCOPE_API_KEY`
2. **`VP_CONFIG_VERSION` 加一**
3. 重启服务

客户端下次启动即拉取新 Key（客户端不做版本比较，每次 200 都覆盖缓存；version 只用于日志与统计）。

## 轮换 token

改 `VP_CONFIG_TOKEN` → 重启服务 → **重新打包客户端并重发**（token 是打包时注入的，这是已接受的代价）。

## 自测

```bash
node server/config-endpoint/test.mjs
```
````

- [ ] **Step 6: Commit**

```bash
git add server/config-endpoint/
git commit -m "feat: 配置端点服务端（F11 最小版，GET /config 换凭据）"
```

---

### Task 2: 客户端取凭据模块 + config.js 接线

**Files:**
- Create: `app/electron/config-endpoint.js`
- Create: `app/electron/selftest/config-endpoint.js`
- Modify: `app/electron/asr/config.js`
- Modify: `app/electron/main.js`（只加自测分发链一个分支）

**Interfaces:**
- Consumes: `store.js` 的 `getMeta` / `setMeta`（既有）；`asr/config.js` 既有的 `loadDevEnv` / `loadStored` / `saveCredentials` / `loadCredentials` / `hasCredentials`
- Produces:
  - `ConfigEndpointError`（`err.kind ∈ 'network' | 'unauthorized' | 'bad-response'`）
  - `readEndpointConfig(path?)` → `{endpoint, token} | null`
  - `fetchRemoteCredentials({ config, timeoutMs?, fetchImpl? })` → `Promise<{apiKey, workspaceId, version}>`，失败抛 `ConfigEndpointError`
  - `asr/config.js` 新增 `refreshFromEndpoint(opts?)` → `Promise<{ok:true, version} | {ok:false, kind, message}>`
  - `asr/config.js` 新增 `bootstrapCredentials(opts?)` → `Promise<{ok:true, source} | {ok:false, kind, message}>`
  - `runConfigSelftest()` 供 `main.js` 自测链调用

- [ ] **Step 1: 写失败测试 `app/electron/selftest/config-endpoint.js`**

```js
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
```

- [ ] **Step 2: 在 `app/electron/main.js` 的自测分发链加分支**

找到 `const selftest = process.env.VP_ASR_SELFTEST ? … : null;` 这一段，在最内层 `null` 之前插入一个新分支，并把新 selftest 的 `run` 函数接进下面那行 `??` 链：

```js
  const selftest = process.env.VP_ASR_SELFTEST
    ? './selftest/asr.js'
    : process.env.VP_SM_SELFTEST
      ? './selftest/machine.js'
      : process.env.VP_POLISH_SELFTEST
        ? './selftest/polish.js'
        : process.env.VP_STORE_SELFTEST
          ? './selftest/store.js'
          : process.env.VP_I18N_SELFTEST
            ? './selftest/i18n.js'
            : process.env.VP_CONFIG_SELFTEST
              ? './selftest/config-endpoint.js'
              : null;
```

并把紧随其后的 `run` 选取改成加一项：

```js
    const run = mod.runAsrSelftest ?? mod.runMachineSelftest ?? mod.runPolishSelftest ?? mod.runStoreSelftest ?? mod.runI18nSelftest ?? mod.runConfigSelftest;
```

- [ ] **Step 3: 运行确认失败**

Run: `cd app && VP_CONFIG_SELFTEST=1 npx electron .`
Expected: FAIL —— `Cannot find module '.../config-endpoint.js'`（自测异常终止，退出码 1）

- [ ] **Step 4: 实现 `app/electron/config-endpoint.js`**

```js
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
```

- [ ] **Step 5: 改 `app/electron/asr/config.js` 加接线**

顶部加两处 import（现有 import 保持不动）：

```js
import { setMeta } from '../store.js';
import { readEndpointConfig, fetchRemoteCredentials, ConfigEndpointError } from '../config-endpoint.js';
```

文件末尾追加：

```js
/**
 * 从端点取回凭据并写入本地缓存。
 *
 * 成功：safeStorage 落盘 + 把配置版本记进 meta（仅用于日志与统计，
 * 客户端不做版本比较——每次 200 都覆盖）。
 * 失败：返回 {ok:false, kind}，不抛——调用方决定要不要打扰用户。
 *
 * @param {{ endpointConfig?: object|null, timeoutMs?: number, fetchImpl?: Function }} [opts]
 *   endpointConfig 传 null 表示「明确没有端点配置」；不传则读 endpoint.built.json。
 */
export async function refreshFromEndpoint(opts = {}) {
  const config = opts.endpointConfig !== undefined ? opts.endpointConfig : readEndpointConfig();
  try {
    const creds = await fetchRemoteCredentials({ config, timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl });
    saveCredentials(creds);
    setMeta('config_version', creds.version);
    console.log(`[授权] 已从端点取回凭据（version=${creds.version}）`);
    return { ok: true, version: creds.version };
  } catch (e) {
    const kind = e instanceof ConfigEndpointError ? e.kind : 'bad-response';
    console.warn(`[授权] 端点取回失败（${kind}）：${e?.message ?? e}`);
    return { ok: false, kind, message: e?.message ?? String(e) };
  }
}

/**
 * 启动时决定「有没有可用凭据」。
 *
 * - 开发模式（.env）：直接可用，不碰端点
 * - 有缓存：立刻可用，**后台**刷新（不 await，端点慢不影响启动）
 * - 什么都没有：等一次端点（带超时）；失败则把 kind 交给调用方去提示
 */
export async function bootstrapCredentials(opts = {}) {
  if (loadDevEnv()) return { ok: true, source: 'env' };
  if (loadStored()) {
    void refreshFromEndpoint(opts);
    return { ok: true, source: 'cache' };
  }
  const r = await refreshFromEndpoint(opts);
  return r.ok ? { ok: true, source: 'endpoint' } : { ok: false, kind: r.kind, message: r.message };
}
```

- [ ] **Step 6: 运行确认通过**

Run: `cd app && VP_CONFIG_SELFTEST=1 npx electron .`
Expected: PASS —— 打印 `[自测] 通过 ...`，退出码 0

- [ ] **Step 7: 跑既有自测确认没回归（`config.js` 被 ASR/润色/状态机共用）**

Run:
```bash
cd app
VP_STORE_SELFTEST=1 npx electron .
VP_SM_SELFTEST=1 npx electron .
VP_I18N_SELFTEST=1 npx electron .
```
Expected: 三个都是 `[自测] 通过`，退出码 0

- [ ] **Step 8: Commit**

```bash
git add app/electron/config-endpoint.js app/electron/selftest/config-endpoint.js app/electron/asr/config.js app/electron/main.js
git commit -m "feat: 客户端从端点取回凭据（含离线自测）"
```

---

### Task 3: 启动接线与用户可见面

**Files:**
- Modify: `app/electron/main.js`
- Modify: `app/electron/ipc.js`
- Modify: `app/shared/i18n/zh-CN.js`
- Modify: `app/shared/i18n/zh-TW.js`
- Modify: `app/shared/i18n/en-US.js`

**Interfaces:**
- Consumes: Task 2 的 `bootstrapCredentials(opts?)` → `{ok:true,source} | {ok:false,kind,message}`；`refreshFromEndpoint(opts?)` → `{ok:true,version} | {ok:false,kind,message}`；既有的 `t(locale, key)`、`getCurrentLocale()`
- Produces: 三语 key `auth.title`、`auth.error.network`、`auth.error.unauthorized`、`auth.error.badResponse`、`auth.retry`、`auth.close`、`tray.refreshAuth`、`key.invalidError`

- [ ] **Step 1: 加三语 key**

`app/shared/i18n/zh-CN.js` 里 `'tray.setKey'` 上一行插入：

```js
  'tray.refreshAuth': '重新获取授权',
```

`'key.emptyError'` 之后插入：

```js
  'key.invalidError': 'API Key 须以 sk- 开头，且工作空间 ID 不能为空',
  // 授权（端点下发）
  'auth.title': '授权',
  'auth.error.network': '未获取到授权，请联系管理员',
  'auth.error.unauthorized': '授权已失效，请联系管理员',
  'auth.error.badResponse': '授权信息异常，请联系管理员',
  'auth.retry': '重试',
  'auth.close': '关闭',
```

`app/shared/i18n/zh-TW.js` 同样位置插入：

```js
  'tray.refreshAuth': '重新取得授權',
```

```js
  'key.invalidError': 'API Key 須以 sk- 開頭，且工作空間 ID 不能為空',
  // 授權（端點下發）
  'auth.title': '授權',
  'auth.error.network': '未取得授權，請聯絡管理員',
  'auth.error.unauthorized': '授權已失效，請聯絡管理員',
  'auth.error.badResponse': '授權資訊異常，請聯絡管理員',
  'auth.retry': '重試',
  'auth.close': '關閉',
```

`app/shared/i18n/en-US.js` 同样位置插入：

```js
  'tray.refreshAuth': 'Re-fetch authorization',
```

```js
  'key.invalidError': 'API Key must start with "sk-" and workspace ID cannot be empty',
  // Authorization (endpoint delivery)
  'auth.title': 'Authorization',
  'auth.error.network': 'Could not obtain authorization. Please contact your administrator.',
  'auth.error.unauthorized': 'Authorization has expired. Please contact your administrator.',
  'auth.error.badResponse': 'Authorization data is invalid. Please contact your administrator.',
  'auth.retry': 'Retry',
  'auth.close': 'Close',
```

- [ ] **Step 2: 改 `app/electron/main.js` 的 import 与启动接线**

import 行：`electron` 的解构里加 `dialog`；把 `hasCredentials` 换成新的两个函数：

```js
import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  screen,
  nativeImage,
  protocol,
  dialog,
} from 'electron';
```

```js
import { bootstrapCredentials, refreshFromEndpoint } from './asr/config.js';
```

> 注：`hasCredentials` 到这里就没有任何引用了（全仓库只有这一处用）。**顺手删掉它和它的导出**，别留死代码；`loadCredentials()` 仍然需要，别删。

把 `app.whenReady()` 里这一段：

```js
  // 无 API Key 时弹输入窗（打包版没有 .env，靠这里拿 Key；开发期有 .env 则不会弹）。
  // 将来 F11 配置端点落地后，hasCredentials 会因端点下发而为 true，此窗自然不再出现。
  const needKey = !hasCredentials();
  const needOnboard = getMeta('first_run_done') !== 'true';
  if (process.platform === 'darwin') {
    // accessory：快捷键/托盘不把本应用变成前台，焦点留在用户正在打字的程序。
    app.setActivationPolicy(needKey || needOnboard ? 'regular' : 'accessory');
  }
  if (needKey) {
    createKeyEntryWindow({ attachDevLogging });
  }
```

替换为：

```js
  // 凭据来源：.env（仅开发）→ 本地缓存 → 内网端点。开发期有 .env 时上面两步都不碰端点。
  const boot = await bootstrapCredentials();
  const needKey = !boot.ok;
  const needOnboard = getMeta('first_run_done') !== 'true';
  if (process.platform === 'darwin') {
    // accessory：快捷键/托盘不把本应用变成前台，焦点留在用户正在打字的程序。
    app.setActivationPolicy(needKey || needOnboard ? 'regular' : 'accessory');
  }
  if (needKey) {
    // 试用者手里没有 Key，给表单没有意义——给一句明确原因 + 重试。
    console.log(`[授权] 启动时无可用凭据（${boot.kind}）`);
    void promptAuthRetry(boot.kind);
  }
```

- [ ] **Step 3: 在 `app/electron/main.js` 加提示与托盘项**

在 `registerShortcuts` 函数之前插入两个函数：

```js
/** 把错误类别翻成人话。三类文案都在 i18n 里，不在这里拼中文。 */
function authErrorMessage(kind) {
  const locale = getCurrentLocale();
  if (kind === 'unauthorized') return t(locale, 'auth.error.unauthorized');
  if (kind === 'bad-response') return t(locale, 'auth.error.badResponse');
  return t(locale, 'auth.error.network');
}

/**
 * 弹「提示 + 重试」。
 *
 * 先按已知原因显示（initialKind 来自启动时那次失败，避免再等一轮超时），
 * 只有用户点「重试」才真的再请求一次。
 */
async function promptAuthRetry(initialKind) {
  const locale = getCurrentLocale();
  let kind = initialKind ?? 'network';
  for (;;) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: t(locale, 'auth.title'),
      message: authErrorMessage(kind),
      buttons: [t(locale, 'auth.retry'), t(locale, 'auth.close')],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return;
    const r = await refreshFromEndpoint();
    if (r.ok) return;
    kind = r.kind;
  }
}

/** 托盘手动刷新：成功静默（只打日志），失败才提示。 */
async function refreshAuthFromTray() {
  const r = await refreshFromEndpoint();
  if (r.ok) return;
  void promptAuthRetry(r.kind);
}
```

`rebuildTray()` 的菜单模板里，在「设置 API Key」那一项之后加：

```js
      { label: t(locale, 'tray.refreshAuth'), click: () => void refreshAuthFromTray() },
      { type: 'separator' },
```

- [ ] **Step 4: 把 `vp:key/save` 的硬编码中文换成 i18n**

`app/electron/ipc.js` 里 `saveCredentials` 会抛硬编码中文（`API Key 须以 sk- 开头…`）。改成在 handler 里捕获取代，走 i18n：

把

```js
  ipcMain.handle('vp:key/save', (_e, { apiKey, workspaceId }) => {
    const key = String(apiKey ?? '').trim();
    const ws = String(workspaceId ?? '').trim();
    if (!key || !ws) throw new Error('API Key 和工作空间 ID 不能为空');
    saveCredentials({ apiKey: key, workspaceId: ws });
    return true;
  });
```

替换为（`t` 与 `getCurrentLocale` 该文件已在用）：

```js
  ipcMain.handle('vp:key/save', (_e, { apiKey, workspaceId }) => {
    const key = String(apiKey ?? '').trim();
    const ws = String(workspaceId ?? '').trim();
    const locale = getCurrentLocale();
    if (!key || !ws) throw new Error(t(locale, 'key.emptyError'));
    try {
      saveCredentials({ apiKey: key, workspaceId: ws });
    } catch {
      // 只可能是 normalizeCreds 判不合法；具体原因不暴露给渲染进程
      throw new Error(t(locale, 'key.invalidError'));
    }
    return true;
  });
```

- [ ] **Step 5: 语法与回归检查**

Run:
```bash
cd app
npx tsc --noEmit
VP_I18N_SELFTEST=1 npx electron .
VP_CONFIG_SELFTEST=1 npx electron .
```
Expected: `tsc` 干净；两个自测都通过（i18n 自测会校验三语 key 齐不齐）

- [ ] **Step 6: 手动验证失败提示路径**

Run（开发模式，`.env` 还在，所以 `bootstrapCredentials` 走 env 不报错；这里验的是托盘那条手动路径）：

```bash
cd app
npm start
```

- 右键托盘 → 菜单里能看到「重新获取授权」
- 点它 → 因为此时**没有** `app/electron/endpoint.built.json`，应弹出「未获取到授权，请联系管理员」+「重试 / 关闭」
- 点「关闭」→ 弹窗消失，应用继续可用（说明失败不影响主链路）

再验启动路径（需要临时屏蔽 `.env`）：

```bash
cd app
mv ../.env ../.env.bak
npm start        # 应弹出同一句提示
mv ../.env.bak ../.env
```

- [ ] **Step 7: Commit**

```bash
git add app/electron/main.js app/electron/ipc.js app/shared/i18n/
git commit -m "feat: 启动时端点取凭据 + 托盘重新获取授权 + 三语文案"
```

---

### Task 4: 构建期注入与打包校验

**Files:**
- Create: `app/electron/endpoint.example.json`
- Create: `app/scripts/prepack-check.mjs`
- Modify: `.gitignore`
- Modify: `app/package.json`

**Interfaces:**
- Consumes: Task 2 的 `readEndpointConfig()` 读的字段名（`endpoint` / `token`）
- Produces: 打包前置检查脚本，`dist:*` 脚本依赖它

- [ ] **Step 1: 写 `app/electron/endpoint.example.json`**

```json
{
  "endpoint": "https://voicepilot.example.internal/config",
  "token": "REPLACE_ME"
}
```

- [ ] **Step 2: 加进 `.gitignore`**

在 `.gitignore` 的「凭证（绝不入库）」段里，`*.pem` 之后插入：

```
# Key 端点下发的真值（token + 内网地址）。样例见 app/electron/endpoint.example.json
app/electron/endpoint.built.json
```

- [ ] **Step 3: 写 `app/scripts/prepack-check.mjs`**

```js
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 打包前置检查：没有端点配置就不许出包。
 *
 * 宁可打包失败，也不要打出一个「装完拿不到 Key」的包——那种包发给同事
 * 之后，排查成本远高于在这里失败一次。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PATH = join(HERE, '..', 'electron', 'endpoint.built.json');

const problems = [];
let j = null;
try {
  j = JSON.parse(readFileSync(PATH, 'utf8'));
} catch {
  problems.push(`读不到或不是合法 JSON：${PATH}`);
}

if (j) {
  const endpoint = String(j.endpoint ?? '').trim();
  const token = String(j.token ?? '').trim();
  if (!endpoint) problems.push('endpoint 为空');
  else if (!endpoint.startsWith('https://')) problems.push(`endpoint 必须是 https:// —— 当前：${endpoint}`);
  if (!token) problems.push('token 为空');
  else if (token === 'REPLACE_ME') problems.push('token 仍是样例里的占位值 REPLACE_ME');
}

if (problems.length) {
  console.error(
    '[打包前置检查] 未通过：\n' +
      problems.map((p) => `  - ${p}`).join('\n') +
      '\n修复：把 app/electron/endpoint.example.json 复制为 app/electron/endpoint.built.json，填入真实的端点地址与 token。'
  );
  process.exit(1);
}

console.log(`[打包前置检查] 通过：${String(j.endpoint).trim()}`);
```

- [ ] **Step 4: 手动验证检查脚本的三种结局**

Run（此时文件还不存在）:
```bash
cd app && node scripts/prepack-check.mjs; echo "exit=$?"
```
Expected: 打印「未通过 … 读不到或不是合法 JSON」，`exit=1`

Run（造一个占位文件 → 应仍失败）:
```bash
cd app
cp electron/endpoint.example.json electron/endpoint.built.json
node scripts/prepack-check.mjs; echo "exit=$?"
```
Expected: 打印「token 仍是样例里的占位值」，`exit=1`

Run（填合法值 → 应通过）:
```bash
cd app
node -e "const f='electron/endpoint.built.json';const j=require('./'+f);j.endpoint='https://vp.internal/config';j.token='real-token';require('fs').writeFileSync(f,JSON.stringify(j,null,2))"
node scripts/prepack-check.mjs; echo "exit=$?"
```
Expected: 打印「通过：https://vp.internal/config」，`exit=0`

最后删掉这个临时文件（它本来就是 gitignore 的）:

```bash
rm app/electron/endpoint.built.json
```

- [ ] **Step 5: 改 `app/package.json` 的打包脚本**

```json
    "dist:win": "node scripts/prepack-check.mjs && vite build && electron-builder --win",
    "dist:win:portable": "node scripts/prepack-check.mjs && vite build && electron-builder --win portable",
    "dist:mac": "node scripts/prepack-check.mjs && vite build && electron-builder --mac"
```

- [ ] **Step 6: 验证脚本串联正确**

Run:
```bash
cd app && npm run dist:win:portable; echo "exit=$?"
```
Expected: 在 `prepack-check` 处就失败并 `exit=1`（因为没有 `endpoint.built.json`），**不会**开始 `vite build` 或下载打包产物

- [ ] **Step 7: Commit**

```bash
git add .gitignore app/electron/endpoint.example.json app/scripts/prepack-check.mjs app/package.json
git commit -m "feat: 端点配置构建期注入 + 打包前置检查"
```

---

### Task 5: 文档同步

**Files:**
- Modify: `README.md`
- Modify: `docs/plans/2026-09-05-voicepilot-prd.md`

**Interfaces:**
- Consumes: Task 1 的端点契约、Task 4 的注入与打包流程
- Produces: 文档层，无代码接口

- [ ] **Step 1: 改 PRD §5.9 的「配置端点（F11）」小节**

在该小节的表格之后、「### 5.10」之前插入：

```markdown
**2026-09-11 最小版契约（M5-A 已实施）**：M5-A 只做「拿 token 换 Key」这一件事，形态为
`GET <endpoint>/config` + `X-VP-Token: <token>` → `200 {"version":n,"apiKey":"sk-…","workspaceId":"…"}`，
`401 {"error":"unauthorized"}`。服务端是单文件 Node 原生 `http/https`（`server/config-endpoint/`），
无数据库、无管理界面。客户端在启动时拉取，端点不可达则沿用本地缓存（`safeStorage` 加密）静默运行。

token 是**打包时注入**的共享令牌（`app/electron/endpoint.built.json`，gitignore），
因此**换 token 需要重新发包**；换 Key 只需改服务端环境变量并把 `VP_CONFIG_VERSION` 加一。
下表要求的 HTTPS 与访问控制同样适用于最小版；限流、审计、版本化多环境配置留 M5-B。

> ⚠️ 端点下发**不等于**对试用者保密（客户端仍持有 Key 明文），也**不替代**内网边界——
> 完整的取舍见 `docs/superpowers/specs/2026-09-11-key-delivery-design.md` §0。
```

- [ ] **Step 2: 给 `README.md` 补一节**

在「打包与分发（给同事试用）」这一节之前插入：

````markdown
## Key 下发（内网端点）

打包版不再由人工分发 DashScope Key，改为**运行时从公司内网 HTTPS 端点取回**。试用者装完即用，不需要填任何东西。

```bash
# 1. 起服务端（部署在内网机器上，细节见 server/config-endpoint/README.md）
cd <repo>
export VP_CONFIG_TOKEN='<发给客户端的 token>'
export VP_DASHSCOPE_API_KEY='sk-…'
export VP_DASHSCOPE_WORKSPACE_ID='<业务空间 ID>'
export VP_CONFIG_VERSION=1
export VP_TLS_CERT=/etc/ssl/voicepilot/fullchain.pem
export VP_TLS_KEY=/etc/ssl/voicepilot/privkey.pem
node server/config-endpoint/server.js

# 2. 打包前注入端点地址与 token（此文件 gitignore，绝不入库）
cp app/electron/endpoint.example.json app/electron/endpoint.built.json
# 填入真实 endpoint 与 token
cd app && npm run dist:win:portable     # prepack-check 会拦住缺失/占位/非 https 的情况

# 3. 轮换 Key
#    改 VP_DASHSCOPE_API_KEY，并把 VP_CONFIG_VERSION 加一，重启服务端即可，不用重发包
# 4. 轮换 token
#    改 VP_CONFIG_TOKEN 之后**必须重新打包重发**（token 是打包时注入的）
```

**客户端行为**：启动时先读本地缓存（有就立刻可用，并在后台刷新）；没有任何可用凭据时才等一次端点（3 秒超时），失败则提示「未获取到授权，请联系管理员」+ 重试。托盘菜单有「重新获取授权」可手动重试，旁边还留着「设置 API Key」供管理员排查。

**自测**：

```bash
cd app
VP_CONFIG_SELFTEST=1 npx electron .   # 本地起 mock 端点，离线可跑
node ../server/config-endpoint/test.mjs
```
````

- [ ] **Step 3: 验证 markdown 结构没坏**

Run: `grep -n "^## " README.md`
Expected: 新增的 `## Key 下发（内网端点）` 出现在「打包与分发（给同事试用）」之前，其余标题顺序不变

- [ ] **Step 4: Commit**

```bash
git add README.md docs/plans/2026-09-05-voicepilot-prd.md
git commit -m "docs: Key 端点下发的用法、轮换与契约"
```

---

## 完成后仍然悬空的事（不在本计划内，别当成遗漏）

1. **F12 按打包 `.app` 复验** —— M5-A 的第四项，是用户在 Mac 上的手工动作，不是代码。
2. **端点地址、token 的真值**，以及谁来部署/开机自启 —— 用户侧。
3. **真实内网端点的证书是否被客户端信任** —— 需真机发一次请求确认；公司 CA 已在系统钥匙串里的话 `tls-ca.js` 会覆盖。失败时先查根证书信任，**不要**改成 `rejectUnauthorized:false`。
