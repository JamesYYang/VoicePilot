# M4 剩余项实现计划（预设 / 历史 / 首次引导 / 换色）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 M4 剩余四项——场景/语气自定义预设、本地历史浏览、首次使用引导、悬浮条换亮色——全部落在一个 `node:sqlite` 单库里，主进程唯一读写，渲染进程经 IPC 存取。

**Architecture:** 新建 `store.js` 作为唯一数据层（`node:sqlite` 同步 API，库文件 `userData/voicepilot.db`）。预设与历史 CRUD 全在 store 层；IPC 只做转发。历史「原文」由渲染进程在 `reviewing` 时上报（文本归渲染进程所有，沿用现有架构）；「润色后文本」在用户「采用」时回写。首次引导用独立 `#onboarding` 窗口。换色纯改 `App.tsx` 样式。

**Tech Stack:** Electron 44（内置 Node 24.20.0，`node:sqlite` 可用，已实测含 FTS5 trigram）+ React 19 + TypeScript strict。**不引入任何原生模块依赖。**

**Spec:** `docs/superpowers/specs/2026-09-06-m4-remaining-design.md`

## Global Constraints

- API Key 只在主进程，渲染进程永不接触（PRD §5.8）。本计划所有新增 IPC 都不传凭据。
- 主进程是 SQLite 唯一读写方，渲染进程永不碰 DB（`node:fs`/`node:sqlite` 都不暴露给它）。
- 内置预设（`is_builtin=1`）可改名/编辑 description，**不可删除**；用户新建的可删。
- 历史 `scene`/`tone` 存**名字快照**（字符串），非预设 id。
- 首次引导只记职业选择 + 场景默认值，**ASR 词表位置留空**（等 F11 下发）。
- 悬浮条换亮色是纯视觉，**不做主题切换**。
- 自测沿用两种既有模式：主进程 `VP_*_SELFTEST=1 npx electron .`（不建窗口、跑完退出）、界面 `VP_UI_SELFTEST=1 npx electron .`（隐藏窗口 + 假 bridge）。
- `node:sqlite` 的 `DatabaseSync` 是同步 API：`prepare(sql).run(...args)` 返回 `{changes, lastInsertRowid}`，`.get(...)` 返回首行或 undefined，`.all(...)` 返回数组。`lastInsertRowid` 用 `Number()` 包一层。

---

### Task 1: 数据层 store.js（建库/播种/CRUD）+ 自测

**Files:**
- Create: `app/electron/store.js`
- Create: `app/electron/selftest/store.js`
- Modify: `app/electron/main.js`（selftest 分支加 `VP_STORE_SELFTEST`）

**Interfaces:**
- Produces（后续任务全部依赖，签名即契约）:
  - `openStore(dbPath?) → DatabaseSync`（幂等；无参用 `userData/voicepilot.db`，传路径用于测试）
  - `saveHistory({ text, durationMs }) → { id: number }`
  - `listHistory({ limit, offset }) → Array<{id, text, polished, scene, tone, duration_ms, created_at}>`
  - `getHistory(id) → 上行对象 | null`
  - `updateHistoryPolish(id, { polished, scene, tone }) → void`
  - `listPresets(kind) → Array<{id, name, description, is_builtin}>`（kind = 'scene' | 'tone'）
  - `savePreset({ id?, kind, name, description }) → { id: number }`（有 id 更新、无 id 新建）
  - `deletePreset(id) → boolean`（内置返回 false 不删）
  - `getMeta(key) → string | null`
  - `setMeta(key, value) → void`

- [ ] **Step 1: 写 store.js**

`app/electron/store.js`：

```js
import { app } from 'electron';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

/**
 * 本地持久化层。主进程是唯一读写方，渲染进程永远碰不到这里。
 *
 * 用 Node 内建的 node:sqlite（DatabaseSync 同步 API）而不是 better-sqlite3：
 * Electron 44 内置 Node 24.20.0，node:sqlite 与 FTS5 trigram 均可用（已实测），
 * 省掉原生模块与 electron-rebuild 一整套。三张表：history / presets / meta。
 */

const BUILTIN_SCENES = ['邮件', '即时通讯', '文档', '社媒'];
const BUILTIN_TONES = ['正式', '口语', '简洁', '热情'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  text        TEXT NOT NULL,
  polished    TEXT,
  scene       TEXT,
  tone        TEXT,
  duration_ms INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS presets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK(kind IN ('scene','tone')),
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_builtin  INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(kind, name)
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

let db = null;

function seedPresets() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM presets').get();
  if (n > 0) return;
  const ins = db.prepare(
    'INSERT INTO presets (kind, name, description, is_builtin, sort_order) VALUES (?,?,?,1,?)'
  );
  BUILTIN_SCENES.forEach((name, i) => ins.run('scene', name, '', i));
  BUILTIN_TONES.forEach((name, i) => ins.run('tone', name, '', i));
}

export function openStore(dbPath) {
  if (db) return db;
  const path = dbPath ?? join(app.getPath('userData'), 'voicepilot.db');
  db = new DatabaseSync(path);
  db.exec(SCHEMA);
  seedPresets();
  return db;
}

// ---------------------------------------------------------------- 历史

export function saveHistory({ text, durationMs }) {
  openStore();
  const r = db
    .prepare('INSERT INTO history (text, polished, scene, tone, duration_ms, created_at) VALUES (?, NULL, NULL, NULL, ?, ?)')
    .run(text, durationMs ?? null, Date.now());
  return { id: Number(r.lastInsertRowid) };
}

export function listHistory({ limit = 200, offset = 0 } = {}) {
  openStore();
  return db
    .prepare('SELECT id, text, polished, scene, tone, duration_ms, created_at FROM history ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(limit, offset);
}

export function getHistory(id) {
  openStore();
  return db
    .prepare('SELECT id, text, polished, scene, tone, duration_ms, created_at FROM history WHERE id = ?')
    .get(id) ?? null;
}

export function updateHistoryPolish(id, { polished, scene, tone }) {
  openStore();
  db.prepare('UPDATE history SET polished = ?, scene = ?, tone = ? WHERE id = ?')
    .run(polished ?? null, scene ?? null, tone ?? null, id);
}

// ---------------------------------------------------------------- 预设

export function listPresets(kind) {
  openStore();
  return db
    .prepare('SELECT id, name, description, is_builtin FROM presets WHERE kind = ? ORDER BY sort_order, id')
    .all(kind);
}

export function savePreset({ id, kind, name, description = '' }) {
  openStore();
  if (id != null) {
    db.prepare('UPDATE presets SET name = ?, description = ? WHERE id = ?')
      .run(name, description, id);
    return { id };
  }
  const { m } = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM presets WHERE kind = ?').get(kind);
  const r = db
    .prepare('INSERT INTO presets (kind, name, description, is_builtin, sort_order) VALUES (?,?,?,0,?)')
    .run(kind, name, description, m + 1);
  return { id: Number(r.lastInsertRowid) };
}

export function deletePreset(id) {
  openStore();
  const row = db.prepare('SELECT is_builtin FROM presets WHERE id = ?').get(id);
  if (!row || row.is_builtin) return false; // 内置预设不可删
  db.prepare('DELETE FROM presets WHERE id = ?').run(id);
  return true;
}

// ---------------------------------------------------------------- 元数据

export function getMeta(key) {
  openStore();
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return r ? r.value : null;
}

export function setMeta(key, value) {
  openStore();
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
```

- [ ] **Step 2: 语法检查**

Run: `cd app && node --check electron/store.js`
Expected: 无输出（语法通过）

- [ ] **Step 3: 写自测**

`app/electron/selftest/store.js`：

```js
import {
  openStore, saveHistory, listHistory, getHistory, updateHistoryPolish,
  listPresets, savePreset, deletePreset, getMeta, setMeta,
} from '../store.js';

export async function runStoreSelftest() {
  console.log('[自测] 本地存储（store）');
  openStore(':memory:');

  // 播种：4 场景 + 4 语气，全 is_builtin=1
  const scenes = listPresets('scene');
  const tones = listPresets('tone');
  const okSeed = scenes.length === 4 && tones.length === 4 &&
    scenes.every((p) => p.is_builtin === 1) && tones.every((p) => p.is_builtin === 1);

  // 历史写入 + 列表
  const { id } = saveHistory({ text: '第一段口述', durationMs: 12000 });
  const rows = listHistory({});
  const okWrite = id === 1 && rows.length === 1 && rows[0].text === '第一段口述' &&
    rows[0].duration_ms === 12000 && rows[0].polished === null;

  // 润色回写
  updateHistoryPolish(id, { polished: '润色版', scene: '邮件', tone: '正式' });
  const got = getHistory(id);
  const okUpdate = got !== null && got.polished === '润色版' && got.scene === '邮件' && got.tone === '正式';

  // 预设增 / 改 / 删
  const { id: pid } = savePreset({ kind: 'scene', name: '周报', description: '每周汇报' });
  const okAdd = listPresets('scene').some((p) => p.id === pid && p.description === '每周汇报');
  savePreset({ id: pid, kind: 'scene', name: '周报', description: '改动后的说明' });
  const okEdit = listPresets('scene').some((p) => p.id === pid && p.description === '改动后的说明');
  const okBuiltinKeep = deletePreset(scenes[0].id) === false; // 内置不可删
  const okDel = deletePreset(pid) === true;

  // meta 读写
  setMeta('first_run_done', 'true');
  const okMeta = getMeta('first_run_done') === 'true';

  const ok = okSeed && okWrite && okUpdate && okAdd && okEdit && okBuiltinKeep && okDel && okMeta;
  console.log(`[自测] ${ok ? '通过' : '失败'} 播种=${okSeed} 写=${okWrite} 更新=${okUpdate} 增=${okAdd} 改=${okEdit} 内置不删=${okBuiltinKeep} 删=${okDel} meta=${okMeta}`);
  return { ok };
}
```

- [ ] **Step 4: 接线 main.js 的 selftest 分支**

`app/electron/main.js`，把现有的 selftest 选择三元链改成：

```js
  const selftest = process.env.VP_ASR_SELFTEST
    ? './selftest/asr.js'
    : process.env.VP_SM_SELFTEST
      ? './selftest/machine.js'
      : process.env.VP_POLISH_SELFTEST
        ? './selftest/polish.js'
        : process.env.VP_STORE_SELFTEST
          ? './selftest/store.js'
          : null;
```

并把 run 选择处改为：

```js
    const run = mod.runAsrSelftest ?? mod.runMachineSelftest ?? mod.runPolishSelftest ?? mod.runStoreSelftest;
```

- [ ] **Step 5: 跑自测**

Run: `cd app && VP_STORE_SELFTEST=1 timeout 60 npx electron .`
Expected: 退出码 0，打印「[自测] 通过」，各子项全 true

- [ ] **Step 6: Commit**

```bash
git add app/electron/store.js app/electron/selftest/store.js app/electron/main.js
git commit -m "feat(store): node:sqlite 数据层（历史/预设/meta）+ 自测"
```

---

### Task 2: 润色预设数据化（prompt/polish + 预设 IPC + studio/sync）

**Files:**
- Modify: `app/electron/llm/prompt.js`（`buildPolishMessages` 接收 `{name, description}`；移除 `SCENES`/`TONES`）
- Modify: `app/electron/selftest/polish.js`（scene/tone 改传对象）
- Modify: `app/electron/ipc.js`（`vp:studio/sync` 从 DB 读预设；新增 `vp:preset/save`、`vp:preset/delete`；去掉 `SCENES/TONES` 导入）
- Modify: `app/electron/preload.cjs`
- Modify: `app/src/global.d.ts`

**Interfaces:**
- Consumes: `listPresets` / `savePreset` / `deletePreset`（Task 1）、`streamPolish`（现有）
- Produces:
  - `Preset = { id: number; name: string; description: string; is_builtin: number }`（global.d.ts 类型，贯穿后续任务）
  - `buildPolishMessages(text, scene, tone)` 其中 scene/tone 为 `{name, description}`
  - `vp:studio/sync` → `{ text, scenes: Preset[], tones: Preset[], defaultScene: string | null }`
  - `vp:preset/save({ id?, kind, name, description }) → { id }`
  - `vp:preset/delete(id) → boolean`
  - `vp:preset/list(kind) → Preset[]`

- [ ] **Step 1: 改 prompt.js**

`app/electron/llm/prompt.js` 整个替换为：

```js
/** 构造润色请求的 system + user 两条消息。scene/tone 是 { name, description }。 */
export function buildPolishMessages(text, scene, tone) {
  const sceneLine = `场景：${scene.name}${scene.description ? `（${scene.description}）` : ''}`;
  const toneLine = `语气：${tone.name}${tone.description ? `（${tone.description}）` : ''}`;
  return {
    system:
      `你是文字润色助手。根据场景和语气改写用户文本，` +
      `只输出改写后的文本，不要解释、不要加引号、不要多余内容。\n\n` +
      `${sceneLine}\n${toneLine}`,
    user: text,
  };
}
```

（`SCENES`/`TONES` 常量从这里删除——预设统一走 DB。）

- [ ] **Step 2: 改 selftest/polish.js 的调用**

`app/electron/selftest/polish.js` 里 `streamPolish({ ... })` 的 scene/tone 改成：

```js
      scene: { name: '邮件', description: '' },
      tone: { name: '正式', description: '' },
```

- [ ] **Step 3: 改 ipc.js 的 studio/sync 与预设通道**

`app/electron/ipc.js` 顶部 import：删掉 `import { SCENES, TONES } from './llm/prompt.js';`，加：

```js
import { listPresets, savePreset, deletePreset, getMeta } from './store.js';
```

`vp:studio/sync` handler 替换为：

```js
  ipcMain.handle('vp:studio/sync', () => ({
    text: pendingStudioText,
    scenes: listPresets('scene'),
    tones: listPresets('tone'),
    defaultScene: getMeta('default_scene'),
  }));
```

在「主应用（Studio）」段末尾加预设通道：

```js
  /** 预设列表。 */
  ipcMain.handle('vp:preset/list', (_e, kind) => listPresets(kind));

  /** 新建/编辑预设（有 id 更新、无 id 新建）。 */
  ipcMain.handle('vp:preset/save', (_e, { id, kind, name, description }) => {
    const r = savePreset({ id: id ?? null, kind, name, description });
    // 返回后由渲染进程自己刷新列表
    return r;
  });

  /** 删除预设。内置返回 false。 */
  ipcMain.handle('vp:preset/delete', (_e, id) => deletePreset(Number(id)));
```

- [ ] **Step 4: preload.cjs 加桥接方法**

在 `app/electron/preload.cjs` 的 `syncStudio` 之后加：

```js
  /** 预设列表（kind = scene | tone）。 */
  listPresets(kind) {
    return ipcRenderer.invoke('vp:preset/list', kind);
  },

  /** 新建/编辑预设。 */
  savePreset(payload) {
    return ipcRenderer.invoke('vp:preset/save', payload);
  },

  /** 删除预设（内置不可删，返回 false）。 */
  deletePreset(id) {
    return ipcRenderer.invoke('vp:preset/delete', id);
  },
```

- [ ] **Step 5: global.d.ts 加类型**

`app/src/global.d.ts` 顶部加 `Preset` 接口，并在 `VoicePilotBridge` 里更新 `syncStudio` 与新增 `savePreset`/`deletePreset`：

```ts
interface Preset {
  id: number;
  name: string;
  description: string;
  is_builtin: number;
}
```

`syncStudio` 签名改为：

```ts
  syncStudio(): Promise<{ text: string; scenes: Preset[]; tones: Preset[]; defaultScene: string | null }>;
```

新增：

```ts
  listPresets(kind: 'scene' | 'tone'): Promise<Preset[]>;
  savePreset(payload: { id?: number; kind: 'scene' | 'tone'; name: string; description: string }): Promise<{ id: number }>;
  deletePreset(id: number): Promise<boolean>;
```

- [ ] **Step 6: 语法检查**

Run: `cd app && node --check electron/llm/prompt.js && node --check electron/ipc.js`
Expected: 无输出（语法通过）

> 说明：`tsc --noEmit` 全量类型检查放到 Task 8 最后一步统一跑——中间任务会因 PolishView / App / uitest 仍用旧 shape 而报错，属预期，不在各中间任务门禁。

- [ ] **Step 7: Commit**

```bash
git add app/electron/llm/prompt.js app/electron/selftest/polish.js app/electron/ipc.js app/electron/preload.cjs app/src/global.d.ts
git commit -m "feat(preset): 预设数据化（prompt 用 name+description，studio/sync 读 DB，preset 增删 IPC）"
```

---

### Task 3: 会话时长 + 历史/采用 IPC

**Files:**
- Modify: `app/electron/telemetry/metrics.js`（`finish()` 加 `dictationDurationMs`）
- Modify: `app/electron/session/machine.js`（`lastDurationMs` getter）
- Modify: `app/electron/ipc.js`（`vp:studio/open` 改签名、`vp:history/save`、`vp:history/list`、`vp:history/get`、`vp:polish/adopt`）
- Modify: `app/electron/preload.cjs`
- Modify: `app/src/global.d.ts`

**Interfaces:**
- Consumes: `saveHistory`/`listHistory`/`getHistory`/`updateHistoryPolish`（Task 1）
- Produces:
  - `machine.lastDurationMs`（getter，number | null）
  - `vp:studio/open({ text, historyId? })`
  - `vp:history/save({ text }) → { id: number | null }`
  - `vp:history/list() → HistoryRow[]`，`HistoryRow = { id, text, polished, scene, tone, duration_ms, created_at }`
  - `vp:history/get(id) → HistoryRow | null`
  - `vp:polish/adopt({ polished, scene, tone }) → boolean`

- [ ] **Step 1: metrics.js 加 dictationDurationMs**

`app/electron/telemetry/metrics.js` 的 `finish()` 返回对象里，在 `stopToCopyableMs` 之后加一行：

```js
      dictationDurationMs:
        this.#toggleAt !== null && this.#stopAt !== null
          ? this.#stopAt - this.#toggleAt
          : null, // 会话时长（快捷键按下 → 松开），供历史落库
```

- [ ] **Step 2: machine.js 暴露 lastDurationMs**

`app/electron/session/machine.js` 私有字段区（`#lastSeqSent` 附近）加：

```js
  #lastDurationMs = null;
```

类里加 getter（放在 `get state()` 之后）：

```js
  /** 最近一次会话的时长（毫秒），无结果时为 null。供 vp:history/save 落库。 */
  get lastDurationMs() {
    return this.#lastDurationMs;
  }
```

`#toReviewing()` 里，`const summary = this.#metrics?.finish();` 之后、`if (!summary) return;` 之后加：

```js
    this.#lastDurationMs = summary.dictationDurationMs ?? null;
```

- [ ] **Step 3: ipc.js 历史/采用通道 + openStudio 改签名**

`app/electron/ipc.js` 顶部 import 加 `saveHistory, listHistory, getHistory, updateHistoryPolish`（合并进 Task 2 已加的 store import 行）。

`pendingStudioText` 声明附近加：

```js
let pendingHistoryId = null;
```

`vp:studio/open` handler 替换为：

```js
  ipcMain.handle('vp:studio/open', (_e, { text, historyId }) => {
    pendingStudioText = String(text ?? '');
    pendingHistoryId = historyId != null ? Number(historyId) : null;
    createStudioWindow({ attachDevLogging });
    const win = getStudioWindow();
    if (win) win.webContents.send('vp:studio/refresh', { text: pendingStudioText });
    return true;
  });
```

在 `vp:polish/start` 之后加：

```js
  /** 历史写入。原文由渲染进程在 reviewing 时上报一次。返回新条目 id。 */
  ipcMain.handle('vp:history/save', (_e, { text }) => {
    const t = String(text ?? '');
    if (!t.trim()) return { id: null };
    const { id } = saveHistory({ text: t, durationMs: machine.lastDurationMs });
    console.log(`[历史] 已保存 #${id}（${t.length} 字，时长 ${machine.lastDurationMs ?? '?'}ms）`);
    return { id };
  });

  /** 历史列表（倒序）。 */
  ipcMain.handle('vp:history/list', () => listHistory({ limit: 200 }));

  /** 历史详情。 */
  ipcMain.handle('vp:history/get', (_e, id) => getHistory(Number(id)));

  /** 采用润色结果：把润色文本 + 场景/语气回写进本次会话的历史条目。 */
  ipcMain.handle('vp:polish/adopt', (_e, { polished, scene, tone }) => {
    if (pendingHistoryId != null) {
      updateHistoryPolish(pendingHistoryId, { polished, scene, tone });
    }
    return true;
  });
```

- [ ] **Step 4: preload.cjs 加/改方法**

`app/electron/preload.cjs`：
- `openStudio(text)` 改为：

```js
  openStudio(payload) {
    return ipcRenderer.invoke('vp:studio/open', payload);
  },
```

- `closeStudio` 之后加：

```js
  /** 保存一段历史（原文）。返回 {id}。 */
  historySave(payload) {
    return ipcRenderer.invoke('vp:history/save', payload);
  },

  /** 历史列表（倒序）。 */
  historyList() {
    return ipcRenderer.invoke('vp:history/list');
  },

  /** 历史详情。 */
  historyGet(id) {
    return ipcRenderer.invoke('vp:history/get', id);
  },

  /** 采用润色结果，回写历史。 */
  adoptPolish(payload) {
    return ipcRenderer.invoke('vp:polish/adopt', payload);
  },
```

- [ ] **Step 5: global.d.ts 加类型**

`app/src/global.d.ts` 加 `HistoryRow` 接口：

```ts
interface HistoryRow {
  id: number;
  text: string;
  polished: string | null;
  scene: string | null;
  tone: string | null;
  duration_ms: number | null;
  created_at: number;
}
```

`VoicePilotBridge` 里：`openStudio` 签名改为

```ts
  openStudio(payload: { text: string; historyId?: number }): Promise<boolean>;
```

新增：

```ts
  historySave(payload: { text: string }): Promise<{ id: number | null }>;
  historyList(): Promise<HistoryRow[]>;
  historyGet(id: number): Promise<HistoryRow | null>;
  adoptPolish(payload: { polished: string; scene: string; tone: string }): Promise<boolean>;
```

- [ ] **Step 6: 语法检查 + 跑状态机自测确认 metrics 改动不回归**

Run: `cd app && node --check electron/ipc.js && node --check electron/session/machine.js && node --check electron/telemetry/metrics.js && VP_SM_SELFTEST=1 timeout 60 npx electron .`
Expected: 无语法错误；`VP_SM_SELFTEST` 退出码 0

- [ ] **Step 7: Commit**

```bash
git add app/electron/telemetry/metrics.js app/electron/session/machine.js app/electron/ipc.js app/electron/preload.cjs app/src/global.d.ts
git commit -m "feat(history): 会话时长 + 历史写入/列表/详情 + 采用回写 IPC"
```

---

### Task 4: 悬浮条换亮色 + reviewing 存历史 + historyId 贯通

**Files:**
- Modify: `app/src/App.tsx`

**Interfaces:**
- Consumes: `vp.historySave`、`vp.openStudio({text, historyId})`（Task 3）

- [ ] **Step 1: 加历史保存 ref 与保存逻辑**

`app/src/App.tsx` 的 ref 区（`lastEndRef` 附近）加：

```tsx
  const historySavedRef = useRef(false);
  const historyIdRef = useRef<number | null>(null);
```

在「从『未在听写』切到 warming 时重置一次文本」的 useEffect 里，`lastEndRef.current = 0;` 之后加：

```tsx
      historySavedRef.current = false;
      historyIdRef.current = null;
```

新增一个 useEffect（放在上面那个 useEffect 之后）：

```tsx
  // reviewing 时把原文写入历史一次。文本归渲染进程所有，主进程只落库。
  // 每次会话只存一次：historySavedRef 在 warming 时重置。
  useEffect(() => {
    if (snap.state !== 'reviewing') return;
    if (historySavedRef.current) return;
    if (fullText.trim().length === 0) return;
    historySavedRef.current = true;
    void vp.historySave({ text: fullText }).then((r) => {
      historyIdRef.current = r?.id ?? null;
    });
  }, [snap.state, fullText, vp]);
```

- [ ] **Step 2: 润色按钮带上 historyId**

`App.tsx` 的「润色」按钮 onClick 里，`void vp.openStudio(fullText);` 改为：

```tsx
              void vp.openStudio({ text: fullText, historyId: historyIdRef.current ?? undefined });
```

- [ ] **Step 3: 换亮色（重写 styles 配色）**

`app/src/App.tsx` 底部 `styles` 对象，把以下值改成亮色（结构、`as const` 保持不变）：

```tsx
  bar: {
    // ...其余字段不动，只改这三项
    background: 'rgba(255, 255, 255, 0.95)',
    border: '1px solid #e5e7eb',
    color: '#1f2937',
  },
  badge: { color: '#1d4ed8', fontSize: 11, letterSpacing: 0.5 },
  notice: { color: '#d97706', fontSize: 11 },
  warn: { color: '#d97706', fontSize: 11 },
  error: { color: '#dc2626', fontSize: 11, flexShrink: 0 },
  draft: { color: '#9ca3af' },
  button: {
    // ...其余字段不动，改这三项
    border: '1px solid #1d4ed8',
    background: '#1d4ed8',
    color: '#ffffff',
  },
  ghost: {
    // ...其余字段不动，改这两项
    border: '1px solid #d1d5db',
    color: '#6b7280',
  },
  hint: { color: '#6b7280', fontSize: 11, flexShrink: 0 },
```

（`text` 滚动区、`actions`、`head` 等样式不动；`draft` 从暗灰 `#8b93a7` 改为浅灰 `#9ca3af`。）

- [ ] **Step 4: 构建烟测**

Run: `cd app && npm run build`
Expected: 构建通过（vite 不校验类型，本步只验 TSX 语法与导入正确）

- [ ] **Step 5: Commit**

```bash
git add app/src/App.tsx
git commit -m "feat(bar): 悬浮条换亮色 + reviewing 存历史 + 润色带 historyId"
```

---

### Task 5: 历史浏览 UI（HistoryView）+ Studio 接线

**Files:**
- Create: `app/src/studio/HistoryView.tsx`
- Modify: `app/src/studio/Studio.tsx`

**Interfaces:**
- Consumes: `vp.historyList`、`vp.historyGet`、`vp.copy`、`vp.openStudio({text, historyId})`（Task 3）

- [ ] **Step 1: 写 HistoryView.tsx**

`app/src/studio/HistoryView.tsx`：

```tsx
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

/**
 * 历史浏览（F6，本期只浏览不搜索）。
 *
 * 列表倒序显示每条的时间与原文片段；点开看全文，可复制、可「润色」带回工作区。
 * 「润色」复用 vp.openStudio，把该条原文 + historyId 交给主应用 —— 采用润色结果时
 * 才能回写同一条历史（vp:polish/adopt 按 pendingHistoryId 更新）。
 */

function fmtTime(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function HistoryView({ bridge }: { bridge?: Window['voicepilot'] } = {}) {
  const vp = bridge ?? window.voicepilot;
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [selected, setSelected] = useState<HistoryRow | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void vp.historyList().then(setRows);
  }, [vp]);

  const open = (r: HistoryRow) => {
    setSelected(r);
    setCopied(false);
  };

  return (
    <div style={styles.page}>
      <aside style={styles.list}>
        {rows.length === 0 && <div style={styles.empty}>还没有历史记录</div>}
        {rows.map((r) => (
          <button key={r.id} style={styles.item(selected?.id === r.id)} onClick={() => open(r)}>
            <div style={styles.itemTime}>{fmtTime(r.created_at)}</div>
            <div style={styles.itemText}>{r.text.slice(0, 40)}</div>
            {(r.scene || r.tone) && (
              <div style={styles.tags}>
                {r.scene && <span style={styles.tag}>{r.scene}</span>}
                {r.tone && <span style={styles.tag}>{r.tone}</span>}
              </div>
            )}
            {r.polished && <span style={styles.polishedTag}>已润色</span>}
          </button>
        ))}
      </aside>

      <main style={styles.detail}>
        {selected ? (
          <>
            <div style={styles.detailMeta}>
              {fmtTime(selected.created_at)}
              {selected.duration_ms != null && ` · ${Math.round(selected.duration_ms / 1000)} 秒`}
            </div>
            <pre style={styles.body}>{selected.text}</pre>
            {selected.polished && (
              <>
                <div style={styles.detailLabel}>润色结果</div>
                <pre style={styles.body}>{selected.polished}</pre>
              </>
            )}
            <div style={styles.actions}>
              <button
                style={styles.primary}
                onClick={() => void vp.copy(selected.polished ?? selected.text)}
              >
                复制
              </button>
              <button
                style={styles.ghost}
                onClick={() => void vp.openStudio({ text: selected.text, historyId: selected.id })}
              >
                润色
              </button>
              {copied && <span style={styles.hint}>已复制</span>}
            </div>
          </>
        ) : (
          <div style={styles.empty}>选中一条历史查看全文</div>
        )}
      </main>
    </div>
  );
}

const styles = {
  page: { flex: 1, minHeight: 0, display: 'flex', background: '#ffffff', color: '#1f2937', fontSize: 13 },
  list: { width: 240, flexShrink: 0, overflowY: 'auto', borderRight: '1px solid #e5e7eb', padding: 8, boxSizing: 'border-box' },
  empty: { margin: 'auto', color: '#9ca3af', padding: 16 },
  item: (active: boolean) => ({
    display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', marginBottom: 4,
    borderRadius: 6, border: 'none', cursor: 'pointer',
    background: active ? '#eff6ff' : 'transparent', color: '#1f2937', fontSize: 12,
  }),
  itemTime: { color: '#9ca3af', fontSize: 11 },
  itemText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  tags: { display: 'flex', gap: 4, marginTop: 4 },
  tag: { padding: '1px 6px', borderRadius: 4, background: '#f3f4f6', color: '#6b7280', fontSize: 11 },
  polishedTag: { marginLeft: 4, color: '#1d4ed8', fontSize: 11 },
  detail: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', padding: 16, gap: 10, boxSizing: 'border-box' },
  detailMeta: { color: '#9ca3af', fontSize: 12, flexShrink: 0 },
  detailLabel: { color: '#6b7280', fontSize: 12, flexShrink: 0 },
  body: { flex: 1, minHeight: 0, margin: 0, padding: 12, borderRadius: 8, border: '1px solid #e5e7eb', background: '#fafafa', overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.6 },
  actions: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  primary: { padding: '5px 14px', borderRadius: 6, border: '1px solid #1d4ed8', background: '#1d4ed8', color: '#ffffff', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  ghost: { padding: '5px 14px', borderRadius: 6, border: '1px solid #d1d5db', background: '#ffffff', color: '#111827', fontSize: 12, cursor: 'pointer' },
  hint: { color: '#6b7280', fontSize: 11 },
} satisfies Record<string, CSSProperties | ((active: boolean) => CSSProperties)>;
```

- [ ] **Step 2: Studio.tsx 接线**

`app/src/studio/Studio.tsx`：
- 顶部 import 加 `import HistoryView from './HistoryView';`
- 内容区渲染改为：

```tsx
      <main style={styles.content}>
        {view === 'polish' ? (
          <PolishView bridge={bridge} />
        ) : view === 'history' ? (
          <HistoryView bridge={bridge} />
        ) : (
          <div style={styles.placeholder}>待实现</div>
        )}
      </main>
```

- [ ] **Step 3: 构建烟测**

Run: `cd app && npm run build`
Expected: 构建通过（vite 不校验类型）

- [ ] **Step 4: Commit**

```bash
git add app/src/studio/HistoryView.tsx app/src/studio/Studio.tsx
git commit -m "feat(history): 历史浏览 UI + Studio 接线"
```

---

### Task 6: 预设管理 UI（PresetManager）+ PolishView 接入 + 采用回写

**Files:**
- Create: `app/src/studio/PresetManager.tsx`
- Modify: `app/src/studio/PolishView.tsx`

**Interfaces:**
- Consumes: `Preset` 类型、`vp.listPresets`、`vp.savePreset`、`vp.deletePreset`、`vp.adoptPolish`、`vp.syncStudio`（新 shape，Task 2）

- [ ] **Step 1: 写 PresetManager.tsx**

`app/src/studio/PresetManager.tsx`：

```tsx
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

/**
 * 预设管理模态框（场景 / 语气）。
 *
 * 内置条目（is_builtin=1）可改名/编辑说明，删除按钮禁用；用户新建的可删。
 * 新增/编辑共用一个输入框表单；保存/删除后经 onChanged 通知父组件刷新下拉。
 */

interface Props {
  kind: 'scene' | 'tone';
  bridge?: Window['voicepilot'];
  onClose: () => void;
  onChanged: () => void;
}

export default function PresetManager({ kind, bridge, onClose, onChanged }: Props) {
  const vp = bridge ?? window.voicepilot;
  const [presets, setPresets] = useState<Preset[]>([]);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);

  const reload = () => {
    void vp.listPresets(kind).then(setPresets);
  };

  useEffect(reload, [vp, kind]);

  const startEdit = (p: Preset) => {
    setEditingId(p.id);
    setName(p.name);
    setDesc(p.description);
  };

  const reset = () => {
    setEditingId(null);
    setName('');
    setDesc('');
  };

  const save = async () => {
    if (!name.trim()) return;
    await vp.savePreset({ id: editingId ?? undefined, kind, name: name.trim(), description: desc.trim() });
    reset();
    reload();
    onChanged();
  };

  const del = async (id: number) => {
    await vp.deletePreset(id);
    reload();
    onChanged();
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.head}>
          <span>{kind === 'scene' ? '管理场景' : '管理语气'}</span>
          <button style={styles.close} onClick={onClose}>×</button>
        </div>

        <div style={styles.list}>
          {presets.map((p) => (
            <div key={p.id} style={styles.row}>
              <div style={styles.rowMain}>
                <div style={styles.rowName}>{p.name}</div>
                {p.description && <div style={styles.rowDesc}>{p.description}</div>}
              </div>
              <button style={styles.link} onClick={() => startEdit(p)}>编辑</button>
              <button style={styles.link} disabled={p.is_builtin === 1} onClick={() => void del(p.id)}>
                {p.is_builtin === 1 ? '内置' : '删除'}
              </button>
            </div>
          ))}
        </div>

        <div style={styles.form}>
          <input
            style={styles.input}
            placeholder="名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            style={styles.input}
            placeholder="说明（可选，内联进润色提示词）"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
          <button style={styles.primary} onClick={() => void save()} disabled={!name.trim()}>
            {editingId == null ? '新增' : '保存'}
          </button>
          {editingId != null && <button style={styles.link} onClick={reset}>取消编辑</button>}
        </div>
      </div>
    </div>
  );
}

const styles = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10 },
  modal: { width: 420, maxHeight: '80vh', display: 'flex', flexDirection: 'column', gap: 10, background: '#ffffff', borderRadius: 10, padding: 16, boxShadow: '0 8px 30px rgba(0,0,0,0.2)', color: '#1f2937', fontSize: 13 },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontWeight: 600 },
  close: { border: 'none', background: 'transparent', fontSize: 18, cursor: 'pointer', color: '#6b7280' },
  list: { display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto' },
  row: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, background: '#f9fafb' },
  rowMain: { flex: 1, minWidth: 0 },
  rowName: { fontWeight: 500 },
  rowDesc: { color: '#6b7280', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  link: { border: 'none', background: 'transparent', color: '#1d4ed8', fontSize: 12, cursor: 'pointer', padding: 2 },
  form: { display: 'flex', gap: 6, alignItems: 'center' },
  input: { flex: 1, minWidth: 0, padding: '5px 8px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 12, outline: 'none' },
  primary: { padding: '5px 12px', borderRadius: 6, border: '1px solid #1d4ed8', background: '#1d4ed8', color: '#ffffff', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
} satisfies Record<string, CSSProperties>;
```

- [ ] **Step 2: 改 PolishView.tsx**

`app/src/studio/PolishView.tsx`：

- import 加 `import PresetManager from './PresetManager';`
- state 类型调整：`scenes`/`tones` 改 `Preset[]`，`scene`/`tone` 改存 `Preset | null`；初始为 null。替换现有相关 state：

```tsx
  const [scenes, setScenes] = useState<Preset[]>([]);
  const [tones, setTones] = useState<Preset[]>([]);
  const [scene, setScene] = useState<Preset | null>(null);
  const [tone, setTone] = useState<Preset | null>(null);
  const [managerKind, setManagerKind] = useState<'scene' | 'tone' | null>(null);
```

- `syncStudio` 的 `StudioSync` 接口与赋值改为新 shape：

```tsx
interface StudioSync {
  text: string;
  scenes: Preset[];
  tones: Preset[];
  defaultScene: string | null;
}
```

useEffect 里：

```tsx
    void vp.syncStudio().then((s: StudioSync) => {
      setText(s.text);
      setScenes(s.scenes);
      setTones(s.tones);
      setScene(s.scenes.find((p) => p.name === s.defaultScene) ?? s.scenes[0] ?? null);
      setTone(s.tones[0] ?? null);
    });
```

- 场景/语气下拉改为按 Preset 渲染，`value={scene?.name ?? ''}`，onChange 用 `find` 找回对象：

```tsx
          <select
            data-testid="polish-scene"
            style={styles.select}
            value={scene?.name ?? ''}
            onChange={(e) => setScene(scenes.find((p) => p.name === e.target.value) ?? null)}
          >
            {scenes.map((p) => (
              <option key={p.id} value={p.name}>{p.name}</option>
            ))}
          </select>
```

语气下拉同理（`polish-tone`、`tones`、`tone`）。

- 工具条加两个「管理」按钮（场景下拉与语气下拉后各一个）：

```tsx
        <button data-testid="manage-scene" style={styles.manage} onClick={() => setManagerKind('scene')}>管理</button>
        <button data-testid="manage-tone" style={styles.manage} onClick={() => setManagerKind('tone')}>管理</button>
```

- `run()` 里的 `startPolish({ text, scene, tone })` 保持不变（scene/tone 现在是 Preset 对象，符合 Task 2 的新签名）。
- 「采用」onClick 改为同时调 adoptPolish 回写：

```tsx
          onClick={() => {
            setText(output);
            setOutput('');
            void vp.adoptPolish({ polished: output, scene: scene?.name ?? '', tone: tone?.name ?? '' });
          }}
```

- 组件末尾、footer 之后渲染模态框：

```tsx
      {managerKind && (
        <PresetManager
          kind={managerKind}
          bridge={bridge}
          onClose={() => setManagerKind(null)}
          onChanged={() => {
            void vp.syncStudio().then((s: StudioSync) => {
              setScenes(s.scenes);
              setTones(s.tones);
            });
          }}
        />
      )}
```

- `styles` 加一个 `manage` 样式（放在 `select` 之后）：

```tsx
  manage: {
    padding: '4px 8px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    background: '#ffffff',
    color: '#111827',
    fontSize: 12,
    cursor: 'pointer',
  },
```

- [ ] **Step 3: 构建烟测**

Run: `cd app && npm run build`
Expected: 构建通过（vite 不校验类型；uitest/run.tsx 旧 shape 的报错留到 Task 8）

- [ ] **Step 4: Commit**

```bash
git add app/src/studio/PresetManager.tsx app/src/studio/PolishView.tsx
git commit -m "feat(preset): 预设管理模态框 + PolishView 接入 + 采用回写历史"
```

---

### Task 7: 首次使用引导（onboarding 窗口 + 页 + 触发）

**Files:**
- Create: `app/electron/onboarding.js`
- Create: `app/src/onboarding/Onboarding.tsx`
- Modify: `app/src/main.tsx`（`#onboarding` 路由）
- Modify: `app/electron/main.js`（启动时查 meta 决定是否弹窗）
- Modify: `app/electron/ipc.js`（`vp:onboarding/save`、`vp:onboarding/close`）
- Modify: `app/electron/preload.cjs`
- Modify: `app/src/global.d.ts`

**Interfaces:**
- Consumes: `openStore`/`getMeta`/`setMeta`（Task 1）、`createOnboardingWindow`（本任务）
- Produces:
  - `createOnboardingWindow({ attachDevLogging }) → BrowserWindow`、`getOnboardingWindow()`
  - `vp:onboarding/save({ profession }) → boolean`
  - `vp:onboarding/close() → boolean`

- [ ] **Step 1: 写 onboarding.js**

`app/electron/onboarding.js`：

```js
import { BrowserWindow } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 首次使用引导窗口（PRD §4.0 / F8）。只问一个问题：工作领域。
 * 独立小窗，复用 createDiagWindow 的二级窗口模式，加载 #onboarding 路由。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
let win = null;

export function createOnboardingWindow({ attachDevLogging }) {
  if (win && !win.isDestroyed()) {
    win.focus();
    return win;
  }

  win = new BrowserWindow({
    width: 420,
    height: 320,
    resizable: false,
    title: '欢迎使用 VoicePilot 闻字',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  attachDevLogging(win);
  win.loadURL('app://voicepilot/index.html#onboarding');
  win.on('closed', () => {
    win = null;
  });
  return win;
}

export function getOnboardingWindow() {
  return win && !win.isDestroyed() ? win : null;
}
```

- [ ] **Step 2: 写 Onboarding.tsx**

`app/src/onboarding/Onboarding.tsx`：

```tsx
import type { CSSProperties } from 'react';

/**
 * 首次使用引导页（F8）。只问一个问题，选择即落盘并关窗。
 * ASR 词表本期留空（等 F11 下发），这里只记职业 + 场景默认值。
 */

const OPTIONS = [
  { key: 'general', label: '通用', hint: '不加载词表，通用口述' },
  { key: 'product_rd', label: '产品与研发', hint: '场景默认「文档」' },
  { key: 'other', label: '其他', hint: '不加载词表，可在设置中自定义' },
] as const;

export default function Onboarding({ bridge }: { bridge?: Window['voicepilot'] } = {}) {
  const vp = bridge ?? window.voicepilot;

  const choose = async (profession: string) => {
    await vp.saveOnboarding({ profession });
    await vp.closeOnboarding();
  };

  return (
    <div style={styles.page}>
      <h1 style={styles.title}>欢迎使用 VoicePilot 闻字</h1>
      <p style={styles.question}>你的工作主要涉及哪个领域？</p>
      <div style={styles.options}>
        {OPTIONS.map((o) => (
          <button key={o.key} style={styles.option} onClick={() => void choose(o.key)}>
            <span style={styles.optionLabel}>{o.label}</span>
            <span style={styles.optionHint}>{o.hint}</span>
          </button>
        ))}
      </div>
      <button style={styles.skip} onClick={() => void choose('general')}>
        跳过（默认通用）
      </button>
    </div>
  );
}

const styles = {
  page: { height: '100vh', boxSizing: 'border-box', padding: 24, display: 'flex', flexDirection: 'column', gap: 12, background: '#ffffff', color: '#1f2937', fontSize: 13 },
  title: { margin: 0, fontSize: 16, fontWeight: 600 },
  question: { margin: 0, color: '#6b7280' },
  options: { display: 'flex', flexDirection: 'column', gap: 8 },
  option: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, padding: '10px 12px', borderRadius: 8, border: '1px solid #d1d5db', background: '#ffffff', cursor: 'pointer', textAlign: 'left' },
  optionLabel: { fontSize: 13, fontWeight: 600, color: '#111827' },
  optionHint: { fontSize: 12, color: '#6b7280' },
  skip: { border: 'none', background: 'transparent', color: '#6b7280', fontSize: 12, cursor: 'pointer', textAlign: 'left', padding: 0 },
} satisfies Record<string, CSSProperties>;
```

- [ ] **Step 3: main.tsx 加 #onboarding 路由**

`app/src/main.tsx`，在 `#studio` 分支之后加：

```tsx
  if (route === 'onboarding') {
    const { default: Onboarding } = await import('./onboarding/Onboarding');
    createRoot(container).render(<Onboarding />);
    return;
  }
```

- [ ] **Step 4: main.js 触发引导窗**

`app/electron/main.js`：
- 顶部 import 加 `import { createOnboardingWindow } from './onboarding.js';` 和 `import { openStore, getMeta } from './store.js';`
- `whenReady` 里 `createBar(); createTray(); registerShortcuts(machine);` 之后加：

```js
  // 首次启动弹引导窗（PRD §4.0）。查 meta 里的 first_run_done 标志。
  if (getMeta('first_run_done') !== 'true') {
    createOnboardingWindow({ attachDevLogging });
  }
```

（`openStore` 无需显式调用——`getMeta` 内部会懒开库。）

- [ ] **Step 5: ipc.js 加 onboarding 通道**

`app/electron/ipc.js` 顶部：加 `import { getOnboardingWindow } from './onboarding.js';`，并在 store 的 import 行补上 `setMeta`（该行现有 `listPresets, savePreset, deletePreset, getMeta` 与 Task 3 补的 `saveHistory, listHistory, getHistory, updateHistoryPolish`，再加 `setMeta`）。在末尾加：

```js
  /** 记录首次引导选择：职业 + 场景默认值 + 首次标志。 */
  ipcMain.handle('vp:onboarding/save', (_e, { profession }) => {
    setMeta('profession', profession);
    setMeta('default_scene', profession === 'product_rd' ? '文档' : '邮件');
    setMeta('first_run_done', 'true');
    return true;
  });

  /** 关闭引导窗。 */
  ipcMain.handle('vp:onboarding/close', () => {
    getOnboardingWindow()?.close();
    return true;
  });
```

- [ ] **Step 6: preload.cjs + global.d.ts**

`preload.cjs` 末尾加：

```js
  /** 记录首次引导选择。 */
  saveOnboarding(payload) {
    return ipcRenderer.invoke('vp:onboarding/save', payload);
  },

  /** 关闭首次引导窗口。 */
  closeOnboarding() {
    return ipcRenderer.invoke('vp:onboarding/close');
  },
```

`global.d.ts` 的 `VoicePilotBridge` 加：

```ts
  saveOnboarding(payload: { profession: string }): Promise<boolean>;
  closeOnboarding(): Promise<boolean>;
```

- [ ] **Step 7: 语法检查 + 构建 + 手动烟测**

Run: `cd app && node --check electron/onboarding.js && node --check electron/ipc.js && node --check electron/main.js && npm run build`
Expected: 全部无报错。

Run: `cd app && npm start`
Expected: 首次启动（库无 `first_run_done`）弹出引导窗；选「产品与研发」→ 窗口关闭；之后重启不再弹。

- [ ] **Step 8: Commit**

```bash
git add app/electron/onboarding.js app/src/onboarding/Onboarding.tsx app/src/main.tsx app/electron/main.js app/electron/ipc.js app/electron/preload.cjs app/src/global.d.ts
git commit -m "feat(onboarding): 首次使用引导（独立小窗 + 职业选择落盘）"
```

---

### Task 8: 界面自测更新 + 全量回归

**Files:**
- Modify: `app/src/uitest/run.tsx`

**Interfaces:**
- Consumes: 新 bridge 全量签名（Task 2/3/6/7）

- [ ] **Step 1: 更新 uitest 里 App 的假 bridge**

`app/src/uitest/run.tsx` 中 App 的假 bridge 对象里，`openStudio` 改为记录对象载荷，并补 `historySave`：

```tsx
  const historySaveCtl: { payload: { text: string } | null } = { payload: null };
```

bridge 里：

```tsx
    openStudio: (payload: { text: string; historyId?: number }) => {
      openStudioCtl.arg = payload.text;
      return Promise.resolve(true);
    },
    historySave: (payload: { text: string }) => {
      historySaveCtl.payload = payload;
      return Promise.resolve({ id: 1 });
    },
```

（`openStudioCtl.arg` 声明类型从 `string | null` 改为 `string | null` 不变——仍存 text 字符串。）

- [ ] **Step 2: 加「reviewing 存历史」断言**

在现有「6.5 润色」段之前，插入对历史保存的断言。因为前面「6. reviewing + 复制」段已经进入过 reviewing，历史已保存过一次；改为在 6.5 段重新 fire reviewing 后检查。把 6.5 段开头改为：

```tsx
  // ---- 6.5 润色 + 历史保存：进入 reviewing 时原文已写入历史一次 ----
  fire('state', { state: 'reviewing', notice: null, truncated: false });
  await flush();
  check('reviewing 时已调用 historySave 且带全文',
    (historySaveCtl.payload?.text ?? '').includes('三件事'),
    JSON.stringify(historySaveCtl.payload));
```

- [ ] **Step 3: 更新 uitest 里 Studio 的假 bridge 与新断言**

把 Studio 假 bridge 的 `syncStudio`、`startPolish` 改成新 shape，并补 `adoptPolish`：

```tsx
  const studioBridge = {
    ...real,
    onStudioRefresh: (cb: (p: { text: string }) => void) => { studioRefresh.cb = cb; return () => {}; },
    syncStudio: () =>
      Promise.resolve({
        text: '测试原文',
        scenes: [{ id: 1, name: '邮件', description: '', is_builtin: 1 }],
        tones: [{ id: 5, name: '正式', description: '', is_builtin: 1 }],
        defaultScene: null,
      }),
    startPolish: (p: { text: string; scene: Preset; tone: Preset }) => {
      polishCall.payload = p;
      return Promise.resolve(true);
    },
    adoptPolish: (p: { polished: string; scene: string; tone: string }) => {
      adoptCall.payload = p;
      return Promise.resolve(true);
    },
    onPolishDelta: (cb: (p: { text: string }) => void) => { studioDelta.cb = cb; return () => {}; },
    onPolishDone: (cb: () => void) => { studioDone.cb = cb; return () => {}; },
    onPolishError: (cb: (p: { message: string }) => void) => { studioError.cb = cb; return () => {}; },
    listPresets: () => Promise.resolve([{ id: 1, name: '邮件', description: '', is_builtin: 1 }]),
    savePreset: () => Promise.resolve({ id: 2 }),
    deletePreset: () => Promise.resolve(true),
  };
```

对应地，`polishCall` 声明类型改为：

```tsx
  const polishCall: { payload: { text: string; scene: Preset; tone: Preset } | null } = { payload: null };
  const adoptCall: { payload: { polished: string; scene: string; tone: string } | null } = { payload: null };
```

并更新「点润色调用了 startPolish 且载荷正确」断言里对 scene/tone 的判断：

```tsx
  check(
    '点润色调用了 startPolish 且载荷正确',
    polishCall.payload?.text === '测试原文' &&
      polishCall.payload?.scene?.name === '邮件' &&
      polishCall.payload?.tone?.name === '正式',
    JSON.stringify(polishCall.payload)
  );
```

- [ ] **Step 4: 加「采用回写」断言**

在「11.5 采用」段，点「采用」之后补：

```tsx
  check('采用后调用了 adoptPolish 回写',
    adoptCall.payload?.polished === '润色后的第一句' &&
      adoptCall.payload?.scene === '邮件' &&
      adoptCall.payload?.tone === '正式',
    JSON.stringify(adoptCall.payload));
```

- [ ] **Step 5: 全量类型检查 + 界面自测 + 主进程自测回归**

Run: `cd app && npx tsc --noEmit`
Expected: 无输出（全量类型检查，这是中间任务延后的最终门禁）

Run: `cd app && npm run build && VP_UI_SELFTEST=1 timeout 90 npx electron .`
Expected: 全部通过，退出码 0

Run: `cd app && VP_STORE_SELFTEST=1 timeout 60 npx electron . && VP_SM_SELFTEST=1 timeout 60 npx electron .`
Expected: 全部退出码 0

- [ ] **Step 6: Commit**

```bash
git add app/src/uitest/run.tsx
git commit -m "test(uitest): 历史保存/采用回写/预设新 shape 断言 + 全量回归"
```

---

## Out of Scope（后续计划）

- 设置视图（F7：快捷键可配置+冲突检测、触发模式、开机启动、职业/词表管理）
- 历史全文搜索（FTS5 trigram，DB 绑定已就绪，`CREATE VIRTUAL TABLE ... fts5(trigram)` 即可）
- 历史条目删除
- ASR 词表加载（等 F11 配置下发）
- 主题切换（悬浮条只做一次性换亮色）
- macOS 托盘 template 图标（等 Mac 到位）
