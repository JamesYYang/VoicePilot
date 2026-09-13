# 常用语（不说话直接选一条采纳）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把听写/润色的结果一键存成「常用语」，之后按第二个全局快捷键打开选择器，不说话直接挑一条落进悬浮条，再走既有采纳写回目标应用。

**Architecture:** 状态机新增第六态 `phrases`，与 `warming/listening/idle/...` 并列；第二个全局快捷键按下即捕获目标窗口并进该态（**不启动 ASR**）。选择器渲染在既有悬浮条窗口内（不新开窗口），选中后转 `reviewing`，复用既有的编辑/润色/复制/采纳写回整条链路。常用语存在同一个 `voicepilot.db` 的新表 `phrases` 里，管理页是 Studio 的新导航项。快照新增 `origin` 字段，让「常用语不落历史」的判据留在状态机里。

**Tech Stack:** Electron 44（内置 Node 24）、React 19 + TS（Vite）、`node:sqlite`、`koffi`（既有依赖，本期不新增）、自建自测（无第三方框架）。

**设计依据:** `docs/superpowers/specs/2026-09-13-common-phrases-design.md`（下称 spec）。每个 Task 的隐含要求都包含 spec §0.1「明确排除」与 §0.2「已知代价」——**不要把它们当缺陷修**。

## Global Constraints

- 平台：Windows 与 macOS 同等对待。**开发机是 Windows**，Windows 路径能在本机自动验；**macOS 的键盘输入行为必须由用户在 Mac 上过**（spec §6 风险 1）。
- 测试无第三方框架：主进程 `cd app && VP_<NAME>_SELFTEST=1 npx electron .`；渲染进程 `cd app && npm run build && VP_UI_SELFTEST=1 npx electron .`（**必须先 build**，否则跑的是 `app/dist/renderer` 里的旧产物）；`cd app && npm run typecheck` 必须干净。
- i18n 三语齐全（`app/shared/i18n/{zh-CN,zh-TW,en-US}.js`），**不得在组件里硬编码文案**；`VP_I18N_SELFTEST` 比较三本字典的 key 集合，任何一本漏 key 都会红。**每个 Task 新增的 key 必须在同一个 Task 里补齐三语**。
- **A2 不能破**：`warming / listening / draining` 三态窗口必须保持 `focusable:false` 且不抢焦点。`phrases` 与 `reviewing` 允许可聚焦（spec §1.3），且**只有 `phrases` 允许主动调用 `focus()`**。
- **不引入任何新依赖**，尤其不得引入需要编译器的依赖。
- **`phrases` 态绝不启动采集**：麦克风不启动、ASR 会话不建立、不产生识别费用。
- **剪贴板从不还原**（上游 spec §0）。本期不改这条。
- 提交粒度：每个 Task 结束提交一次。
- **`focus()` 与「归还焦点」两条路径都无法自动测**，集中在 Task 9 的真机清单。所以每个 Task 的完成报告都必须说明哪些是自动验的、哪些只能真机验。

## File Structure

**新增**

| 文件 | 职责 |
|---|---|
| `app/src/phrases/title.ts` | `derivePhraseTitle(text)`：从正文取选择器用的短标题。纯函数，带边界自测 |
| `app/src/studio/PhrasesView.tsx` | Studio「常用语」页：左列表 + 右详情（改标题/正文、保存、删除、新建） |
| `docs/common-phrases-test-runbook.md` | 真机验证清单（Task 9） |

**改动**

| 文件 | 改什么 |
|---|---|
| `app/electron/store.js` | `phrases` 表；`savePhrase/listPhrases/updatePhrase/deletePhrase/touchPhrase`；`getPhraseShortcut/setPhraseShortcut`；`resolvePolishTarget`（纯函数） |
| `app/electron/ipc.js` | `vp:phrases/*` 五个通道；`vp:session/toggle-phrases`、`vp:session/use-phrase`；`vp:shortcut/get-phrase`、`vp:shortcut/set-phrase`；`emit()` 在 `phrases` 态主动 `focus()`；machine 构造注入 `activateTarget` 与 `shouldRestoreFocus`；`vp:polish/adopt` 改用 `resolvePolishTarget` |
| `app/electron/session/machine.js` | 第六态 `phrases`；`origin` 字段；`openPhrases/usePhrase`；`isBarFocusable` 含 `phrases`；`#closePhrases`/`#dismiss` 的焦点归还；`onAudioFrame` 早退 |
| `app/electron/shortcut.js` | 快捷键按槽位（`main`/`phrases`）保存；`defaultPhraseAccel`；`currentAccel(slot)` |
| `app/electron/inject/index.js` | 新增 `activateTarget`/`activateWith`（只置前不发键），并把 `decidePaste` 的激活步骤抽成共享的 `activateStep` |
| `app/electron/main.js` | 启动时注册第二个快捷键 |
| `app/electron/preload.cjs`、`app/src/global.d.ts` | 桥方法与类型（含 `SessionSnapshot.origin`、`PhraseRow`） |
| `app/src/App.tsx` | `phrases` 态渲染选择器；头部「存为常用语」图标；`phraseText` 生命周期；`origin` 门禁历史落库；高度 effect 纳入列表 |
| `app/src/studio/Studio.tsx` | 导航加「常用语」 |
| `app/src/studio/SettingsView.tsx` | `ShortcutSetting` 槽位化，加第二块 |
| `app/electron/selftest/{store,shortcut,machine,inject}.js` | 各加本期的断言 |
| `app/src/uitest/run.tsx` | 所有 `fire('state', ...)` 补 `origin`；选择器/保存按钮/Studio 页的断言 |
| `app/shared/i18n/{zh-CN,zh-TW,en-US}.js` | 三语新增键 |
| `docs/plans/2026-09-05-voicepilot-prd.md`、`README.md` | 落地后同步（Task 9） |

**不动的**：不新增依赖；`inject/win.js`、`inject/mac.js` 一行不改（复用它们已有的 `activate`）。

---

### Task 1: 修掉 `vp:polish/adopt` 的 id 回落活雷（可独立先落地）

这是 spec §2.5 那件事。**它与常用语无关，本身就是个今天就在的 bug**：`app/src/App.tsx:517` 传 `id: historyIdRef.current ?? undefined`，而 `app/electron/ipc.js:459` 把「未传 id」判为 Studio 路径并回落到 `pendingHistoryId` —— 于是历史落库失败时，采纳的润色结果会被写进 Studio 上一次打开的那条无关记录。

**Files:**
- Modify: `app/electron/store.js`（末尾加纯函数）
- Modify: `app/electron/ipc.js:458-464`
- Modify: `app/src/App.tsx:517`
- Modify: `app/src/global.d.ts`（`adoptPolish` 的 `id` 允许 `null`）
- Modify: `app/electron/preload.cjs`（`adoptPolish` 的注释）
- Test: `app/electron/selftest/store.js`

**Interfaces:**
- Produces: `resolvePolishTarget(id: number | null | undefined, pendingHistoryId: number | null): number | null` —— 从 `app/electron/store.js` 导出，供 Task 5 的 `vp:polish/adopt` 使用（本期只有这一处消费者）。

- [ ] **Step 1: 在 store.js 加纯函数**

加在 `app/electron/store.js` 的「快捷键」小节之前：

```js
// ---------------------------------------------------------------- 采纳目标行

/**
 * 采纳润色结果时该写进哪一条历史。
 *
 * 三态必须分清，混起来就会写错行：
 *   - `undefined`（**没传**这个字段）= Studio 一路的旧行为，回落到 pendingHistoryId；
 *   - `null`（**显式传了空**）= 本次没有历史行（例如从常用语来的采纳），
 *     **绝不能**回落到 pendingHistoryId —— 那会写进上次「打开应用」留下的陈旧行；
 *   - 数字 = 就用它。
 *
 * 抽成纯函数是因为这条分支肉眼看不见、删掉也没测试会红。与 isBarFocusable /
 * classifyForeground 同一个理由。
 */
export function resolvePolishTarget(id, pendingHistoryId) {
  if (id === undefined) return pendingHistoryId ?? null;
  if (id === null) return null;
  const n = Number(id);
  return Number.isFinite(n) ? n : null;
}
```

- [ ] **Step 2: 让 `vp:polish/adopt` 用它**

`app/electron/ipc.js`：把 `resolvePolishTarget` 加进第 11 行那条 `./store.js` 的 import 列表，然后把 handler 换成：

```js
  /**
   * 采用润色结果：把润色文本 + 场景/语气回写进本次会话的历史条目。
   *
   * 目标行的选择见 resolvePolishTarget：显式 null 表示「本次没有历史行」，
   * **不得**回落到 pendingHistoryId —— 悬浮条的历史落库失败时 id 就是 null，
   * 回落会把润色结果写进 Studio 上一次打开的那条无关记录。
   */
  ipcMain.handle('vp:polish/adopt', (_e, { id, polished, scene, tone }) => {
    const target = resolvePolishTarget(id, pendingHistoryId);
    if (target != null) {
      updateHistoryPolish(target, { polished, scene, tone });
    }
    return true;
  });
```

- [ ] **Step 3: 渲染层保留 null，并同步类型与注释**

`app/src/App.tsx:517`，把

```tsx
          id: historyIdRef.current ?? undefined,
```

改成

```tsx
          // 保留 null：显式 null 表示「本次没有历史行」，主进程不会回落到
          // Studio 的 pendingHistoryId（那会写错行）。只有 Studio 一路才省略 id。
          id: historyIdRef.current,
```

**这一步必须同时改类型，否则上一步的 `null` 过不了 typecheck**（`historyIdRef.current` 的类型是 `number | null`）：

`app/src/global.d.ts`：

```ts
  /**
   * 采用润色结果，回写历史。
   * id 显式传 null = 本次没有历史行（例如从常用语来的采纳），主进程**不会**回落；
   * 整个字段省略 = Studio 一路，主进程回落到 pendingHistoryId。
   */
  adoptPolish(payload: { id?: number | null; polished: string; scene: string; tone: string }): Promise<boolean>;
```

`app/electron/preload.cjs` 里 `adoptPolish` 上方的注释同步成：

```js
  /**
   * 采用润色结果，回写历史。
   * payload: { id?: number | null, polished, scene, tone }
   *   - 悬浮条**显式带 id**（本条会话的历史行）；没有历史行时传 null，
   *     主进程不会回落到 pendingHistoryId；
   *   - Studio 一路可整体省略 id，由主进程回落到 pendingHistoryId。
   */
```

（Task 5 的 Step 7 里也列了这条类型改动 —— 那时它已经改好了，只需确认一致，不要重复改。）

- [ ] **Step 4: 加断言**

`app/electron/selftest/store.js`：把 `resolvePolishTarget` 加进顶部 `../store.js` 的 import 列表，然后在 `okUpdateText` 那段之后、算 `ok` 之前插入：

```js
  // 采纳润色的目标行选择。第二条是本次修的活雷：显式 null 必须**不**回落，
  // 否则悬浮条历史落库失败时，润色结果会写进 Studio 上次打开的那条无关记录。
  const okTargetExplicitNull = resolvePolishTarget(null, 42) === null;
  const okTargetFallback = resolvePolishTarget(undefined, 42) === 42;
  const okTargetExplicitId = resolvePolishTarget(7, 42) === 7;
  const okTargetNoPending = resolvePolishTarget(undefined, null) === null;
```

并入 `ok`：

```js
  const ok = okSeed && okWrite && okUpdate && okDelHistory && okDelGone && okDelMissing && okAdd && okEdit && okBuiltinKeep && okDel && okMeta && okTrilingual &&
    okMigrateMiss && okMigrateHit && okMigrateIdem &&
    okMigrateBackfill && okMigrateList && okMigrateBackfillIdem &&
    okShortcutDefault && okShortcutSet && okShortcutOverwrite &&
    okUpdateText &&
    okTargetExplicitNull && okTargetFallback && okTargetExplicitId && okTargetNoPending;
```

日志行末尾追加（照该行既有风格）：

```
 采纳目标行=${okTargetExplicitNull && okTargetFallback && okTargetExplicitId && okTargetNoPending}
```

- [ ] **Step 5: 跑测试**

Run: `cd app && npm run typecheck && VP_STORE_SELFTEST=1 npx electron .`
Expected: typecheck 干净；store 自测 `通过`、退出码 0。

Run: `cd app && VP_INJECT_SELFTEST=1 npx electron .`
Expected: 通过（本 Task 没碰 inject，这条只是确认基线是绿的）。

- [ ] **Step 6: 提交**

```bash
git add app/electron/store.js app/electron/ipc.js app/src/App.tsx app/src/global.d.ts app/electron/preload.cjs app/electron/selftest/store.js
git commit -m "fix(adopt): 修掉润色结果写错历史行 —— 显式 null 不再回落到 pendingHistoryId"
```

---

### Task 2: `phrases` 表 + store API

**Files:**
- Modify: `app/electron/store.js`（`SCHEMA` + 新 API 段）
- Test: `app/electron/selftest/store.js`

**Interfaces:**
- Produces（Task 5/6/7/8 都要用，签名照抄 history 那一组）：
  - `savePhrase({ title, text }): { id: number }`
  - `listPhrases({ limit?: number, offset?: number }): PhraseRow[]`（按 `COALESCE(used_at, created_at) DESC, id DESC`）
  - `updatePhrase(id, { title, text }): boolean`
  - `deletePhrase(id): boolean`
  - `touchPhrase(id): boolean`
  - `PhraseRow = { id, title, text, created_at, updated_at, used_at }`

- [ ] **Step 1: 建表**

`app/electron/store.js`：在 `SCHEMA` 模板字符串里、`meta` 表之后追加：

```sql
CREATE TABLE IF NOT EXISTS phrases (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  used_at    INTEGER
);
```

并把文件顶部「三张表：history / presets / meta」的注释改成「四张表：history / presets / phrases / meta」。

**不需要写迁移函数**：`initStore()` 每次都 `d.exec(SCHEMA)`，而这里是 `CREATE TABLE IF NOT EXISTS`，旧库会自己长出这张表（与 presets 那次必须 `ALTER TABLE` 补列不同）。

- [ ] **Step 2: 实现 API**

在 `app/electron/store.js` 的「元数据」小节之前插入：

```js
// ---------------------------------------------------------------- 常用语

/**
 * 列表按「最近使用优先」排：用过就用 used_at，没用过退回 created_at。
 * id DESC 是决胜位，保证同一毫秒内插入的多条顺序稳定。
 */
export function listPhrases({ limit = 200, offset = 0 } = {}) {
  openStore();
  return db
    .prepare(
      `SELECT id, title, text, created_at, updated_at, used_at FROM phrases
       ORDER BY COALESCE(used_at, created_at) DESC, id DESC LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
}

export function savePhrase({ title, text }) {
  openStore();
  const now = Date.now();
  const r = db
    .prepare('INSERT INTO phrases (title, text, created_at, updated_at, used_at) VALUES (?,?,?,?,NULL)')
    .run(title, text, now, now);
  return { id: Number(r.lastInsertRowid) };
}

/** 改标题/正文。返回是否命中一行（id 不存在时诚实返回 false）。 */
export function updatePhrase(id, { title, text }) {
  openStore();
  const r = db
    .prepare('UPDATE phrases SET title = ?, text = ?, updated_at = ? WHERE id = ?')
    .run(title, text, Date.now(), id);
  return r.changes > 0;
}

export function deletePhrase(id) {
  openStore();
  const r = db.prepare('DELETE FROM phrases WHERE id = ?').run(id);
  return r.changes > 0;
}

/** 记一次「被选中」（只动 used_at，不动 updated_at —— 它不是编辑）。 */
export function touchPhrase(id) {
  openStore();
  const r = db.prepare('UPDATE phrases SET used_at = ? WHERE id = ?').run(Date.now(), id);
  return r.changes > 0;
}
```

- [ ] **Step 3: CRUD 与排序断言**

`app/electron/selftest/store.js`：顶部加 `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));`（该文件目前没有）。import 列表加 `savePhrase, listPhrases, updatePhrase, deletePhrase, touchPhrase`，然后在 `okTargetNoPending` 之后插入：

```js
  // ---- 常用语：CRUD ----
  const { id: ph1 } = savePhrase({ title: '问候', text: '您好，收到您的反馈，我先看一下。' });
  const { id: ph2 } = savePhrase({ title: '收尾', text: '有问题随时找我。' });
  const okPhSave = listPhrases({}).length === 2;

  const okPhUpdate = updatePhrase(ph1, { title: '问候（改）', text: '改过的正文' }) === true;
  const okPhUpdateMiss = updatePhrase(999999, { title: 'x', text: 'y' }) === false;
  const phEdited = listPhrases({}).find((p) => p.id === ph1);
  const okPhUpdateFields =
    phEdited?.title === '问候（改）' && phEdited?.text === '改过的正文' &&
    phEdited?.updated_at >= phEdited?.created_at;

  const okPhDelMiss = deletePhrase(999999) === false;

  // ---- 常用语：used_at 驱动排序 ----
  // 没用过时按 created_at 倒序：后插入的 ph2 在前。
  const okPhOrderByCreated = listPhrases({})[0].id === ph2;

  // touch 一条更早创建的，它必须跳到最前 —— 这是「最近使用优先」的唯一证据。
  await sleep(2); // 避免 used_at 与 created_at 落在同一毫秒（sqlite 存整数毫秒）
  const okPhTouch = touchPhrase(ph1) === true;
  const okPhTouchMiss = touchPhrase(999999) === false;
  const okPhOrderByUsed = listPhrases({})[0].id === ph1;

  const okPhDelete = deletePhrase(ph1) === true;
  const okPhDeleteGone = listPhrases({}).length === 1 && listPhrases({})[0].id === ph2;
```

- [ ] **Step 4: 旧库建表断言（「不需要写迁移函数」的唯一证据）**

同一文件，在 `okMigrateBackfillIdem` 之后插入。**复用同一个「旧 schema」实例** —— 它建表时只有 `presets`，正好模拟升级：

```js
  // ---- 常用语表在旧库上被自动建出 ----
  // 上面那个 oldDb 是用旧 schema 手建的（只有 presets，没有 phrases），经
  // openStoreWithDb 走完整管线后必须长出 phrases 表。本项目在 presets 三语列上
  // 踩过迁移的坑，所以这条不能只靠推理。
  const phTable = oldDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='phrases'")
    .get();
  const okPhraseTableCreated = phTable?.name === 'phrases';
```

- [ ] **Step 5: 更新 ok 与日志行**

```js
  const ok = …（Task 1 的那串）… && okUpdateText &&
    okTargetExplicitNull && okTargetFallback && okTargetExplicitId && okTargetNoPending &&
    okPhSave && okPhUpdate && okPhUpdateMiss && okPhUpdateFields &&
    okPhDelMiss && okPhOrderByCreated && okPhTouch && okPhTouchMiss && okPhOrderByUsed &&
    okPhDelete && okPhDeleteGone && okPhraseTableCreated;
```

日志行追加 `常用语=${okPhSave && okPhUpdate && okPhUpdateFields && okPhOrderByCreated && okPhOrderByUsed && okPhDelete && okPhDeleteGone} 常用语建表=${okPhraseTableCreated}`。

- [ ] **Step 6: 跑测试**

Run: `cd app && VP_STORE_SELFTEST=1 npx electron .`
Expected: `通过`、退出码 0。

- [ ] **Step 7: 提交**

```bash
git add app/electron/store.js app/electron/selftest/store.js
git commit -m "feat(phrases): store 新增 phrases 表与 CRUD（含 used_at 排序与旧库建表断言）"
```

---

### Task 3: `activateTarget` —— 只置前、不发键的跨平台原语

spec §2.7。**必须保住 `app/electron/selftest/inject.js:149` 那条断言**：activate 抛异常时，粘贴路径要给出 `reason === 'send-failed'`。所以公共步骤抽出来后**不能**自己吞异常 —— 由两个调用方各自决定抛异常映射成什么。

**Files:**
- Modify: `app/electron/inject/index.js`
- Test: `app/electron/selftest/inject.js`

**Interfaces:**
- Produces:
  - `activateTarget(target: Target | null): Promise<ActivateResult>`，`ActivateResult = {ok:true} | {ok:false, reason:'no-target'|'stale'|'activate-failed'|'permission'}`
  - `activateWith(platform, target)` —— 与 `pasteWith` 同款的测试接缝
- Consumes: 各平台模块既有的 `activate(target)`

- [ ] **Step 1: 抽出共享的激活步骤并加两个导出**

`app/electron/inject/index.js`：把 `decidePaste` 整个替换成下面四段（`pasteWith` 与 `pasteTo` 一行不动）：

```js
/**
 * 激活步骤：置前 → 回读确认。**故意不接住异常**。
 *
 * 两个调用方对「activate 抛异常」的归因不同，且各自都有断言钉着：
 *   - 粘贴路径（decidePaste）：抛异常 → `send-failed`（既有断言，见 selftest/inject.js:149）；
 *   - 只置前路径（activateWith）：抛异常 → `activate-failed`（它根本没有发键这一步）。
 * 统一在这里吞掉会把前者改坏。
 */
async function activateStep(platform, target) {
  if (!platform || !target) return { ok: false, reason: 'no-target' };

  const a = await platform.activate(target);
  if (!a?.ok) return { ok: false, reason: a?.reason ?? 'activate-failed' };

  // 平台实现回读到的前台标识。Windows 是 HWND(number)，macOS 是 pid(number)。
  return classifyForeground(target.hwnd ?? target.pid, a.id);
}

/**
 * 实际编排。抽成独立函数只是为了让 pasteWith 有**唯一出口**，好在那一处统一打诊断；
 * 逻辑与判定完全在内，未做任何改动。
 */
async function decidePaste(platform, target) {
  try {
    // 顺序是安全属性：确认为止一次键都不能发（见 spec 2026-09-13 §3）。
    const act = await activateStep(platform, target);
    if (!act.ok) return act;

    platform.sendPaste();
    return { ok: true };
  } catch (e) {
    console.warn(`[注入] 粘贴失败：${e?.message ?? e}`);
    return { ok: false, reason: 'send-failed' };
  }
}

/**
 * 只置前、不发任何按键。用于「关掉常用语选择器后把焦点还给用户原来的应用」。
 * 与 pasteTo 共用 activateStep，避免两份激活与确认逻辑漂移。
 *
 * 失败一律不抛、只回 reason：调用方（状态机）在关闭路径上不该因为归还焦点失败
 * 而中断收尾 —— 失败只写日志（spec §6 第 6 条）。
 */
export async function activateWith(platform, target) {
  try {
    return await activateStep(platform, target);
  } catch (e) {
    console.warn(`[注入] 置前失败：${e?.message ?? e}`);
    return { ok: false, reason: 'activate-failed' };
  }
}

/** 把 target 置前。调用方负责不要在这之后发键 —— 本函数只做前置。 */
export function activateTarget(target) {
  return activateWith(impl, target);
}
```

- [ ] **Step 2: 加断言**

`app/electron/selftest/inject.js`：import 加 `activateWith`，在 `rThrow` 那段之后插入：

```js
  // ---- 只置前（activateWith）：不发键是它的全部意义 ----
  // 关键手法：假 platform **故意不提供 sendPaste** —— 一旦实现里混进了发键，
  // 调用会抛 TypeError 并被 activateWith 兜成 activate-failed，这条断言立刻红。
  const mkActivateOnly = (activateResult) => {
    const calls = { activate: 0 };
    return {
      calls,
      platform: {
        activate: async () => {
          calls.activate += 1;
          return activateResult;
        },
      },
    };
  };

  const actOk = mkActivateOnly({ ok: true, id: 1 });
  const rActOk = await activateWith(actOk.platform, { kind: 'win', hwnd: 1 });
  check('只置前：确认到前台 → ok，且不需要 sendPaste',
    rActOk?.ok === true && actOk.calls.activate === 1,
    JSON.stringify({ r: rActOk, calls: actOk.calls }));

  const actMismatch = mkActivateOnly({ ok: true, id: 2 });
  const rActMismatch = await activateWith(actMismatch.platform, { kind: 'win', hwnd: 1 });
  check('只置前：回读不匹配 → activate-failed',
    rActMismatch?.reason === 'activate-failed', JSON.stringify(rActMismatch));

  const actFail = mkActivateOnly({ ok: false, reason: 'permission' });
  const rActFail = await activateWith(actFail.platform, { kind: 'win', hwnd: 1 });
  check('只置前：透传平台 reason',
    rActFail?.reason === 'permission', JSON.stringify(rActFail));

  const actNull = mkActivateOnly({ ok: true, id: 1 });
  const rActNull = await activateWith(actNull.platform, null);
  check('只置前：target 为 null → no-target 且不调 activate',
    rActNull?.reason === 'no-target' && actNull.calls.activate === 0,
    JSON.stringify({ r: rActNull, calls: actNull.calls }));

  const actThrows = {
    platform: {
      activate: async () => {
        throw new Error('boom');
      },
    },
  };
  const rActThrows = await activateWith(actThrows.platform, { kind: 'win', hwnd: 1 });
  check('只置前：activate 抛异常 → activate-failed（不抛给调用方）',
    rActThrows?.reason === 'activate-failed', JSON.stringify(rActThrows));
```

- [ ] **Step 3: 跑测试，重点确认既有 reason 断言没回归**

Run: `cd app && VP_INJECT_SELFTEST=1 npx electron .`
Expected: 通过、退出码 0。**特别确认这两条仍绿**：
- `activate 失败 → 透传 reason 且**一次键都不发**`（`permission`）
- `activate 抛异常 → send-failed 且**不发键**`

任何一条变红都说明 `activateStep` 把异常吞掉了 —— 回去改 Step 1，**不要改断言**。

- [ ] **Step 4: 提交**

```bash
git add app/electron/inject/index.js app/electron/selftest/inject.js
git commit -m "feat(inject): 新增只置前不发键的 activateTarget，并与粘贴路径共享激活步骤"
```

---

### Task 4: 状态机第六态 `phrases`

spec §1。这一 Task 只动状态机与它的自测，不碰 IPC / 界面。

**Files:**
- Modify: `app/electron/session/machine.js`
- Test: `app/electron/selftest/machine.js`

**Interfaces:**
- Consumes: Task 3 的 `activateTarget`、既有的 `captureTarget` 注入
- Produces:
  - `isBarFocusable('phrases') === true`
  - `machine.openPhrases(): Promise<{ok:true}|{ignored:true}>`（在 `phrases` 态调用 = 关闭）
  - `machine.usePhrase(): Promise<{ok:true}|{ignored:true}>`
  - `getSnapshot()` 多一个 `origin: 'dictation' | 'phrase'`
  - 构造参数新增 `activateTarget`、`shouldRestoreFocus`

- [ ] **Step 1: 允许 `phrases` 可聚焦**

`app/electron/session/machine.js:46-48`：

```js
export function isBarFocusable(state) {
  return state === 'reviewing' || state === 'phrases';
}
```

该函数上方的注释保留原有 A2 说明，并追加：

```
 * `phrases` 是 spec 2026-09-13 §1.3 的**有意破例**：选择器的全部价值就是键盘输入，
 * 而用户是主动按了快捷键才进来的，不存在「被抢焦点」。
```

还要更新文件头部那张状态流转图（`machine.js:13-17`），把新态画进去 —— 那张图是后来人读这个文件的第一入口，漏掉它会直接误导读者的心智模型：

```
 *   idle ──toggle──▶ warming ──task-started──▶ listening ──toggle──▶ draining
 *                        │                                              │
 *                    再按一次取消                               task-finished / 20s 超时
 *                        ▼                                              ▼
 *                       idle                                        reviewing ──复制/关闭──▶ idle
 *
 *   另有 phrases（常用语选择器）一态，由第二个快捷键进出：idle ──短语键──▶ phrases
 *   ──选中──▶ reviewing（目标窗口一路保留）。它不启动 ASR 会话，见 openPhrases。
```

- [ ] **Step 2: 字段与构造注入**

import 行改成：

```js
import { captureTarget as defaultCaptureTarget, activateTarget as defaultActivateTarget } from '../inject/index.js';
```

私有字段区（`#target = null;` 之后）追加：

```js
  #origin = 'dictation';
  #activateTarget;
  #shouldRestoreFocus;
```

构造参数：

```js
  constructor({
    emit,
    maxAttempts = MAX_ATTEMPTS,
    backoffMs = BACKOFF_MS,
    createSession,
    credentials,
    captureTarget,
    activateTarget,
    shouldRestoreFocus,
  }) {
```

构造函数体内（`#captureTarget` 赋值之后）追加：

```js
    this.#activateTarget = activateTarget ?? defaultActivateTarget;
    // 默认**永不**归还焦点：没被显式注入时不做这件事，比做错更安全。
    // 生产由 ipc.js 注入 () => getBar()?.isFocused() ?? false（spec §1.4 的闸门）。
    // 与 captureTarget 同一个注入手法：状态机不认识 BrowserWindow。
    this.#shouldRestoreFocus = shouldRestoreFocus ?? (() => false);
```

- [ ] **Step 3: 快照带 `origin`，`start()` 重置**

```js
  getSnapshot() {
    return { state: this.#state, notice: this.#notice, truncated: this.#truncated, origin: this.#origin };
  }
```

`start()` 的重置块里（`this.#truncated = false;` 附近）加一行：

```js
    this.#origin = 'dictation';
```

- [ ] **Step 4: 三条新方法与焦点归还**

在 `toggle()` 之后、`start()` 之前插入：

```js
  // ------------------------------------------------------------ 常用语选择器

  /**
   * 第二个全局快捷键。语义与 toggle 同款：在 idle 开选择器，在 phrases 关掉它。
   * 其余四态**一律忽略** —— warming/listening/draining 正在录音或收尾，切走会丢
   * 掉这段听写；reviewing 里已经躺着一段结果，弹选择器会把它顶掉。
   * 宁可「按了没反应」，也不要静默毁掉用户已有的内容（spec §1.2）。
   */
  async openPhrases() {
    if (this.#state === 'phrases') return this.#closePhrases();
    if (this.#state !== 'idle') return { ignored: true };

    // 与 start() 同款：必须在条获得焦点**之前**捕获，那之后前台就变成我们自己了。
    this.#target = this.#captureTarget();
    this.#setState('phrases');
    return { ok: true };
  }

  /**
   * 选中一条常用语：phrases → reviewing。**目标窗口保留**（采纳还要用它）。
   * 正文由渲染进程持有并灌进编辑区 —— 这里只负责状态事实（文本归渲染进程所有）。
   */
  async usePhrase() {
    if (this.#state !== 'phrases') return { ignored: true };
    this.#origin = 'phrase';
    this.#setState('reviewing');
    return { ok: true };
  }

  /** 关掉选择器：回 idle，并把焦点还给用户原来的应用。 */
  async #closePhrases() {
    const target = this.#target;
    this.#target = null;
    this.#origin = 'dictation';
    // **顺序是安全属性**：先回 idle，让 emit 里的 setFocusable(false) 与
    // resetBarHeight() 全部落地，再置前。反过来的话，那两下 frame change / 尺寸
    // 复位会把刚建立的激活扰动走 —— 这正是 Plan 2B 真机排障的结论（spec §1.4）。
    this.#setState('idle');
    await this.#restoreFocus(target);
    return { ok: true };
  }

  /**
   * 把前台还给 target。失败静默（用户按 Esc 就是想走，此刻弹错误是打扰）。
   * 闸门在调用方：只有「我们确实还拿着焦点」时才归还。
   */
  async #restoreFocus(target) {
    if (!target) return;
    if (!this.#shouldRestoreFocus()) return;
    try {
      const r = await this.#activateTarget(target);
      if (!r?.ok) console.warn(`[常用语] 归还焦点失败：${r?.reason ?? 'unknown'}`);
    } catch (e) {
      console.warn(`[常用语] 归还焦点异常：${e?.message ?? e}`);
    }
  }
```

- [ ] **Step 5: `#dismiss()` 走同一条归还路径**

把 `#dismiss()` 换成：

```js
  async #dismiss() {
    const target = this.#target;
    // 只有「从常用语来的 reviewing」需要归还：那条路的焦点是我们主动拿的
    // （见 openPhrases 与 ipc.js 的 focus()）。听写一路的焦点从来不是我们拿的，
    // 且用户可能中途点开了别的应用 —— 无条件置前会把焦点从他刚切过去的地方拽回来。
    const fromPhrase = this.#origin === 'phrase';

    this.#queue.clear();
    this.#target = null;
    this.#origin = 'dictation';
    this.#setState('idle');
    if (fromPhrase) await this.#restoreFocus(target);
  }
```

（`toggle()` 里 `if (this.#state === 'reviewing') return this.#dismiss();` 不用改，它本来就 return 这个 promise。）

- [ ] **Step 6: 采集早退列表加 `phrases`**

`onAudioFrame` 的第一行：

```js
    // phrases 也要挡：选择器态渲染进程本来就不采集，但状态机不该依赖调用方的自觉。
    if (this.#state === 'idle' || this.#state === 'reviewing' || this.#state === 'phrases') return;
```

- [ ] **Step 7: 加自测**

`app/electron/selftest/machine.js`：在 `testCaptureTarget` 之后、入口之前插入：

```js
// ---------------------------------------------------------------- 常用语选择器

/**
 * 第六态 phrases：捕获时机、状态门禁、origin、以及焦点归还的顺序与闸门。
 * 真实的 focus() 与置前没法自动验（spec §6 风险 1/3），这里验的是**编排**。
 */
async function testPhrases() {
  console.log('\n[9] 常用语选择器：捕获时机 / 状态门禁 / origin / 焦点归还');

  const mk = (opts = {}) => {
    FakeSession.all = []; // 每个用例从零开始数会话，否则「不建会话」的断言数不准
    const calls = { capture: 0, activate: 0 };
    const activated = [];
    let restore = opts.shouldRestoreFocus ?? true;
    const m = new SessionMachine({
      emit() {},
      credentials: {},
      createSession: () => new FakeSession({}),
      captureTarget: () => {
        calls.capture += 1;
        return { kind: 'win', hwnd: 5 };
      },
      activateTarget: async (t) => {
        calls.activate += 1;
        activated.push(t);
        return { ok: true };
      },
      shouldRestoreFocus: () => restore,
    });
    return { m, calls, activated };
  };

  // ---- 捕获发生在进 phrases 之前，且只捕获一次 ----
  const a = mk();
  await a.m.openPhrases();
  check('openPhrases 进 phrases 态', a.m.state === 'phrases', a.m.state);
  check('捕获一次', a.calls.capture === 1, `${a.calls.capture} 次`);
  check('进 phrases 前已持有目标', a.m.getTarget() !== null, JSON.stringify(a.m.getTarget()));

  // ---- 非 idle 态一律忽略 ----
  const b = mk();
  await b.m.start();
  check('listening 下 openPhrases 被忽略',
    (await b.m.openPhrases()).ignored === true && b.m.state === 'listening', b.m.state);

  // 主快捷键在 phrases 态同样忽略（不串「关掉并开始听写」两个跃迁）
  const c = mk();
  await c.m.openPhrases();
  await c.m.toggle();
  check('主快捷键在 phrases 态被忽略', c.m.state === 'phrases', c.m.state);

  // ---- usePhrase：origin 翻成 phrase，目标保留 ----
  const d = mk();
  await d.m.openPhrases();
  await d.m.usePhrase();
  check('usePhrase 进 reviewing', d.m.state === 'reviewing', d.m.state);
  check('origin 翻成 phrase', d.m.getSnapshot().origin === 'phrase', d.m.getSnapshot().origin);
  check('reviewing 期目标仍持有（采纳要用）', d.m.getTarget() !== null, JSON.stringify(d.m.getTarget()));

  // ---- 关掉选择器：回 idle、清空目标、归还焦点 ----
  const e = mk();
  await e.m.openPhrases();
  await e.m.openPhrases(); // 再按一次 = 关闭
  check('再按一次回到 idle', e.m.state === 'idle', e.m.state);
  check('关闭后清空目标', e.m.getTarget() === null, JSON.stringify(e.m.getTarget()));
  check('关闭时归还焦点一次', e.calls.activate === 1, `${e.calls.activate} 次`);
  check('归还的是捕获到的那个目标',
    JSON.stringify(e.activated[0]) === JSON.stringify({ kind: 'win', hwnd: 5 }),
    JSON.stringify(e.activated[0]));

  // ---- 闸门：条不持有焦点时不归还（避免把焦点从用户刚切过去的应用拽回来）----
  const f = mk({ shouldRestoreFocus: false });
  await f.m.openPhrases();
  await f.m.openPhrases();
  check('闸门为 false 时不置前', f.calls.activate === 0, `${f.calls.activate} 次`);

  // ---- 从常用语来的 reviewing 关闭时同样归还；听写来的不归还 ----
  const g = mk();
  await g.m.openPhrases();
  await g.m.usePhrase();
  await g.m.toggle(); // reviewing → dismiss
  check('从常用语来的 reviewing 关闭时归还焦点', g.calls.activate === 1, `${g.calls.activate} 次`);
  check('关闭后 origin 复位 dictation',
    g.m.getSnapshot().origin === 'dictation', g.m.getSnapshot().origin);

  const h = mk();
  await h.m.start();
  await h.m.toggle(); // → reviewing（origin 仍是 dictation）
  check('听写来的 reviewing origin=dictation',
    h.m.getSnapshot().origin === 'dictation', h.m.getSnapshot().origin);
  await h.m.toggle(); // dismiss
  check('听写来的 reviewing 关闭时不置前（既有行为不变）',
    h.calls.activate === 0, `${h.calls.activate} 次`);

  // ---- start() 把 origin 重置回 dictation ----
  const i = mk();
  await i.m.openPhrases();
  await i.m.usePhrase();
  check('用例前置：此时 origin=phrase', i.m.getSnapshot().origin === 'phrase');
  await i.m.toggle(); // dismiss → idle
  await i.m.start();
  check('start() 重置 origin=dictation',
    i.m.getSnapshot().origin === 'dictation', i.m.getSnapshot().origin);

  // ---- phrases 态不建会话、不入音频队列（不产生识别费用）----
  // 断言必须落在**会话数量**上。原先写的「state 仍是 phrases」是个恒真断言：
  // onAudioFrame 就算不早退，state 也不会变，那条断言永远绿、什么也没测。
  // mk() 每次都会把 FakeSession.all 清空，所以这里的 0 是真实的。
  const j = mk();
  await j.m.openPhrases();
  check('phrases 态不建 ASR 会话（没有会话就没有识别费用）',
    FakeSession.all.length === 0, `${FakeSession.all.length} 个会话`);
  j.m.onAudioFrame({ seq: 1, cumSamples: 1600 }, Buffer.alloc(3200));
  check('phrases 态收到音频帧也不建会话、不抛',
    FakeSession.all.length === 0 && j.m.state === 'phrases',
    `${FakeSession.all.length} 个会话 / ${j.m.state}`);
}
```

`testBarFocusable` 里补一条：

```js
  check('phrases 可聚焦（选择器需要键盘输入）', isBarFocusable('phrases') === true);
```

入口处调用 `await testPhrases();`。

- [ ] **Step 8: 跑测试**

Run: `cd app && VP_SM_SELFTEST=1 npx electron .`
Expected: 全部通过、退出码 0。

- [ ] **Step 9: 提交**

```bash
git add app/electron/session/machine.js app/electron/selftest/machine.js
git commit -m "feat(phrases): 状态机新增第六态 phrases（选择器）+ origin 与焦点归还"
```

---

### Task 5: IPC 通道 + 第二个快捷键槽位

**Files:**
- Modify: `app/electron/store.js`、`app/electron/shortcut.js`、`app/electron/ipc.js`、`app/electron/main.js`
- Modify: `app/electron/preload.cjs`、`app/src/global.d.ts`
- Test: `app/electron/selftest/shortcut.js`、`app/electron/selftest/store.js`

**Interfaces:**
- Consumes: Task 2 的 store API、Task 3 的 `activateTarget`、Task 4 的 `openPhrases`/`usePhrase`
- Produces:
  - `defaultPhraseAccel(platform): string`；`currentAccel(slot = 'main'): string`；`applyShortcut(machine, accel, slot = 'main'): boolean`；`boundShortcut(slot = 'main'): string | null`
  - IPC：`vp:phrases/list|save|update|delete|touch`、`vp:session/toggle-phrases`、`vp:session/use-phrase`、`vp:shortcut/get-phrase`、`vp:shortcut/set-phrase`
  - 桥：`phrasesList/phrasesSave/phrasesUpdate/phrasesDelete/phrasesTouch/togglePhrases/usePhrase/getPhraseShortcut/setPhraseShortcut`

- [ ] **Step 1: store 侧短语快捷键**

`app/electron/store.js` 的「快捷键」小节末尾追加：

```js
const PHRASE_SHORTCUT_KEY = 'phrase_shortcut';

/** 用户自定义的常用语快捷键。未设置返回 null，调用方用默认值。 */
export function getPhraseShortcut() {
  const v = getMeta(PHRASE_SHORTCUT_KEY);
  return v && v.trim() ? v : null;
}

export function setPhraseShortcut(accel) {
  setMeta(PHRASE_SHORTCUT_KEY, String(accel));
}
```

- [ ] **Step 2: shortcut.js 槽位化**

`app/electron/shortcut.js`：

顶部 import 改成：

```js
import { globalShortcut } from 'electron';
import { getShortcut, getPhraseShortcut } from './store.js';
```

`defaultAccel` 之后加：

```js
/** 平台默认的常用语快捷键。避开主键、系统菜单键与输入法切换键。 */
export function defaultPhraseAccel(platform = process.platform) {
  return platform === 'darwin' ? 'Alt+Shift+Space' : 'Ctrl+Alt+Space';
}

const DEFAULT_FOR = (slot) => (slot === 'phrases' ? defaultPhraseAccel() : defaultAccel());

/** 当前生效的快捷键（用户自定义优先）。trim 是因为 store 存的是原值，可能带空白。 */
export function currentAccel(slot = 'main') {
  const stored = slot === 'phrases' ? getPhraseShortcut() : getShortcut();
  return (stored ?? DEFAULT_FOR(slot)).trim();
}
```

把原来的 `currentAccel`、`let boundAccel = null`、`boundShortcut`、`applyShortcut` 整段替换为：

```js
/** 已绑定的 accelerator，按槽位分开存。 */
const boundAccel = new Map();

/** 当前已绑定的 accelerator（测试与排查用）。slot 省略即主快捷键。 */
export function boundShortcut(slot = 'main') {
  return boundAccel.get(slot) ?? null;
}

/**
 * 注册新键、成功后才注销旧键。返回是否成功。**按槽位（main/phrases）各管一套**。
 * 失败（被别的程序占用，或 accelerator 非法）时不改 store ——
 * 保持「当前生效键」与「已存键」一致。
 *
 * 两条来自实测的硬约束：
 *  1. register 对非法 accelerator（如 'Ctrl+ '）会**抛异常**而不是返回 false，
 *     所以「先注销后注册」会让旧热键彻底失效 —— 必须先注册、成功后才注销。
 *  2. **挂起期间 register 必然返回 false**（实测：setSuspended(true) 后
 *     register('Control+Alt+Shift+F10') → false，且 isRegistered 也是 false）。
 *     录制快捷键时主进程处于挂起态，而渲染进程的重渲染时机不受我们控制，
 *     所以这里必须先恢复再注册，否则每一次改键都会误报「已被占用」。
 */
export function applyShortcut(machine, accel, slot = 'main') {
  const prev = boundAccel.get(slot) ?? null;

  // 见注释第 2 条：无论调用方处于什么状态，注册前先确保未挂起。
  setShortcutSuspended(false);

  const handler =
    slot === 'phrases'
      ? () => {
          void machine.openPhrases();
        }
      : () => {
          // 直接驱动状态机，不再经渲染进程转发（状态只有一个源头）
          void machine.toggle();
        };

  let ok = false;
  try {
    ok = globalShortcut.register(accel, handler);
  } catch (e) {
    // 非法 accelerator 走这里。当成注册失败处理，旧键未被注销，仍然生效。
    console.error(`[快捷键] ${accel} 注册异常：${e?.message ?? e}`);
    ok = false;
  }

  // 重录当前键：重复注册必然返回 false，但它本来就在生效 —— 视为成功，避免误报冲突。
  if (!ok && prev === accel) return true;

  if (ok) {
    if (prev && prev !== accel) globalShortcut.unregister(prev);
    boundAccel.set(slot, accel);
    console.log(`[快捷键] ${slot} ${accel} 已注册`);
  } else {
    console.error(`[快捷键] ${slot} ${accel} 注册失败：可能已被其他程序占用`);
    boundAccel.set(slot, prev); // 旧键从未被注销，仍指向它
  }
  return ok;
}
```

**`boundShortcut()` 不带参时返回主槽位** —— 既有 shortcut 自测的调用点一个都不用改。

- [ ] **Step 3: 加短语槽位的自测**

`app/electron/selftest/shortcut.js`：

顶部 import 加上 `defaultPhraseAccel`：

```js
import { applyShortcut, boundShortcut, defaultAccel, defaultPhraseAccel, setShortcutSuspended } from '../shortcut.js';
```

`fakeMachine` 补 `openPhrases`：

```js
  const fakeMachine = { toggle() {}, openPhrases() {} };
```

在 `okSuspendedRerecord` 之后、`globalShortcut.unregisterAll()` 之前插入：

```js
  // ---- 7. 常用语槽位：与主槽位互不干扰 ----
  const okPhraseDefault =
    defaultPhraseAccel('win32') === 'Ctrl+Alt+Space' &&
    defaultPhraseAccel('darwin') === 'Alt+Shift+Space';

  const A2 = 'Control+Alt+Shift+F12';
  // 防御：别让本用例的成败依赖前面几个用例的注册/注销序列。
  globalShortcut.unregister(C);
  const okPhraseFirst =
    applyShortcut(fakeMachine, A2, 'phrases') === true &&
    globalShortcut.isRegistered(A2) === true &&
    boundShortcut('phrases') === A2;
  // 主槽位此刻绑的是 A（用例 6 之后），注册短语键不得把它顶掉
  const okMainKept = boundShortcut('main') === A && globalShortcut.isRegistered(A) === true;

  // 短语槽位换键：旧的短语键被注销，主键仍不受影响
  const okPhraseReplace =
    applyShortcut(fakeMachine, C, 'phrases') === true &&
    globalShortcut.isRegistered(C) === true &&
    globalShortcut.isRegistered(A2) === false &&
    globalShortcut.isRegistered(A) === true;

  // 短语槽位撞主槽位：register 返回 false → 视为失败，且**不得**改绑定、不得注销主键
  const okPhraseConflict =
    applyShortcut(fakeMachine, A, 'phrases') === false &&
    boundShortcut('phrases') === C &&
    globalShortcut.isRegistered(A) === true;
```

把它们并进 `ok` 与日志行。

**注意 `C` 的注册状态**：用例 4 里 `applyShortcut(C)` 之后紧跟着 `applyShortcut(A)`，而「成功注册新键后注销旧键」会把 C 注销掉 —— 所以进入用例 7 时**已注册的只有 A**（主槽位），C 与 A2 都是空闲的。（对照：用例 4 之后 A 注册、C 未注册、B 未注册。）用例 7 直接用 C 注册短语槽位是可行的；为避免依赖这条推理，在 `okPhraseFirst` 之前加一行防御性的 `globalShortcut.unregister(C);`，让用例不受前面用例的影响。

- [ ] **Step 4: store 自测补短语快捷键**

`app/electron/selftest/store.js`：import 加 `getPhraseShortcut, setPhraseShortcut`，在快捷键那三条之后插入：

```js
  const okPhraseShortcutDefault = getPhraseShortcut() === null;
  setPhraseShortcut('Control+Alt+Space');
  const okPhraseShortcutSet = getPhraseShortcut() === 'Control+Alt+Space';
```

并入 `ok` 与日志行。

- [ ] **Step 5: ipc.js —— machine 注入、`phrases` 态 focus、新通道**

`app/electron/ipc.js`：

(a) import 调整：`./store.js` 那行加上 `savePhrase, listPhrases, updatePhrase, deletePhrase, touchPhrase, getPhraseShortcut, setPhraseShortcut`；`./shortcut.js` 那行加上 `defaultPhraseAccel`；`./inject/index.js` 那行改成 `import { pasteTo, activateTarget } from './inject/index.js';`。

(b) machine 构造（原 `:83`）：

```js
  const machine = new SessionMachine({
    emit,
    activateTarget,
    // 归还焦点的闸门：只有条确实持有焦点时才还 —— 用户可能在看结果时点开了
    // 别的应用，无条件置前会把焦点从他刚切过去的地方硬拽回来（spec §1.4）。
    shouldRestoreFocus: () => getBar()?.isFocused() ?? false,
  });
```

(c) `emit()` 里、`resetBarHeight()` 那段之后、`bar.webContents.send` 之前插入：

```js
      // phrases 态**主动抢焦点**（唯一一处）。选择器的全部价值就是键盘输入，
      // 而窗口从 focusable:false 翻成 true 只是「允许被点击」，并不会真的激活；
      // 不调 focus() 的话搜索框收不到按键，搜索与 ↑↓ 全废。
      // reviewing **不在此列** —— 它从不主动 focus（见本函数开头那段注释）。
      if (payload?.state === 'phrases') {
        bar.focus();
        bar.webContents.focus();
      }
```

(d) 会话通道区，紧跟 `vp:session/toggle` 之后：

```js
  /** 第二个快捷键与选择器内 Esc 共用：phrases 态下语义是「关掉选择器」。 */
  ipcMain.handle('vp:session/toggle-phrases', async () => {
    await machine.openPhrases();
    return machine.getSnapshot();
  });

  /** 选中一条常用语：切到 reviewing。正文归渲染进程所有，不经这里转发。 */
  ipcMain.handle('vp:session/use-phrase', async () => {
    await machine.usePhrase();
    return machine.getSnapshot();
  });
```

(e) 主应用区之后新增一段：

```js
  // ---------------------------------------------------------------- 常用语

  /** 列表按「最近使用优先」，与选择器的排序一致。 */
  ipcMain.handle('vp:phrases/list', () => listPhrases({ limit: 200 }));

  ipcMain.handle('vp:phrases/save', (_e, { title, text }) =>
    savePhrase({ title: String(title ?? ''), text: String(text ?? '') })
  );

  ipcMain.handle('vp:phrases/update', (_e, { id, title, text }) => {
    const n = Number(id);
    if (!Number.isFinite(n)) return false;
    return updatePhrase(n, { title: String(title ?? ''), text: String(text ?? '') });
  });

  ipcMain.handle('vp:phrases/delete', (_e, id) => deletePhrase(Number(id)));

  /** 被选中一次。渲染进程不 await 它（失败只影响排序）。 */
  ipcMain.handle('vp:phrases/touch', (_e, id) => touchPhrase(Number(id)));
```

(f) 快捷键区新增两条：

```js
  /** 读常用语快捷键。与 vp:shortcut/get 同形状，另一个槽位。 */
  ipcMain.handle('vp:shortcut/get-phrase', () => {
    const custom = getPhraseShortcut();
    return { accel: custom ?? defaultPhraseAccel(), isDefault: custom == null };
  });

  /** 设常用语快捷键。冲突（含与主快捷键撞车）时 ok:false 且不生效。 */
  ipcMain.handle('vp:shortcut/set-phrase', (_e, accel) => {
    const next = String(accel ?? '').trim();
    if (!next) return { ok: false, accel: currentAccel('phrases') };
    const ok = applyShortcut(machine, next, 'phrases');
    if (ok) setPhraseShortcut(next);
    return { ok, accel: currentAccel('phrases') };
  });
```

挂起/恢复复用既有的 `vp:shortcut/suspend` —— `setShortcutSuspended` 管的是整个 `globalShortcut`，两个槽位一起挂起正是录制时要的行为。

- [ ] **Step 6: main.js 启动注册第二键**

`app/electron/main.js`：确认顶部有 `import { applyShortcut, currentAccel } from './shortcut.js';`（缺哪个补哪个）。把启动注册那段（原 `:509-513`）替换成：

```js
  // 启动注册两个快捷键：store 里的值可能损坏（非法 accelerator 会让 register 抛异常）。
  // 绝不能让异常冒泡 —— 后面还有凭据、引导窗等启动步骤，抛出去就全被跳过。
  // applyShortcut 内部已 try/catch，这里再兜一层，纯粹为了启动序列万无一失。
  // 短语键注册失败只打日志（spec §0.2 的已知代价）：用户可在设置页重录时看到冲突提示。
  for (const slot of ['main', 'phrases']) {
    try {
      applyShortcut(machine, currentAccel(slot), slot);
    } catch (e) {
      console.error(`[快捷键] ${slot} 启动注册失败：${e?.message ?? e}`);
    }
  }
```

- [ ] **Step 7: 桥与类型**

`app/electron/preload.cjs`，在「听写会话」小节加：

```js
  /** 第二个快捷键与选择器内 Esc 共用：phrases 态下语义是「关掉选择器」。 */
  togglePhrases() {
    return ipcRenderer.invoke('vp:session/toggle-phrases');
  },

  /** 选中一条常用语：切到 reviewing。正文由渲染进程自己灌进编辑区。 */
  usePhrase() {
    return ipcRenderer.invoke('vp:session/use-phrase');
  },
```

在「主应用（Studio）」小节加：

```js
  /** 常用语列表（最近使用优先）。 */
  phrasesList() {
    return ipcRenderer.invoke('vp:phrases/list');
  },

  /** 存一条常用语。返回 {id}。 */
  phrasesSave(payload) {
    return ipcRenderer.invoke('vp:phrases/save', payload);
  },

  /** 改标题/正文。返回是否命中一行。 */
  phrasesUpdate(payload) {
    return ipcRenderer.invoke('vp:phrases/update', payload);
  },

  /** 删一条。返回是否真的删掉了。 */
  phrasesDelete(id) {
    return ipcRenderer.invoke('vp:phrases/delete', id);
  },

  /** 记一次被选中（驱动「最近使用优先」）。调用方不该 await。 */
  phrasesTouch(id) {
    return ipcRenderer.invoke('vp:phrases/touch', id);
  },
```

在「快捷键（F7）」小节加：

```js
  /** 读常用语快捷键 { accel, isDefault }。 */
  getPhraseShortcut() {
    return ipcRenderer.invoke('vp:shortcut/get-phrase');
  },

  /** 设置常用语快捷键。冲突时返回 { ok:false } 且不生效。 */
  setPhraseShortcut(accel) {
    return ipcRenderer.invoke('vp:shortcut/set-phrase', accel);
  },
```

`app/src/global.d.ts`：

**只加下面这段**（新增类型，没有既有消费者，加它不会弄红任何东西）：

```ts
/** 一条常用语。字段名与 store.js 的 SELECT 一致。 */
interface PhraseRow {
  id: number;
  title: string;
  text: string;
  created_at: number;
  updated_at: number;
  used_at: number | null;
}
```

> ⚠️ **`SessionSnapshot` 的改动不在本 Task，而在 Task 6。** 原因是它约束了任务的边界：`SessionSnapshot` 被**两处渲染层文件平行镜像**（`app/src/App.tsx` 的本地 `SessionState`/`Snapshot`，以及 `app/src/uitest/run.tsx` 里 16 处 `fire('state',…)` 字面量）。本 Task 一旦给它加必填的 `origin`，那 20 处立刻变红，而那两个文件是 Task 6 的范围 —— 结果是本 Task 交付时 `npm run typecheck` 必然不干净，与 Global Constraints 直接冲突。
>
> 桥声明的返回类型**不需要**跟着改：`preload.cjs` 的实现是 `ipcRenderer.invoke(...)`（返回 `Promise<any>`），`global.d.ts` 只是声明、不参与实现的可赋值性检查。所以本 Task 声明 `togglePhrases(): Promise<SessionSnapshot>` 时用**当前**的 `SessionSnapshot`（还没有 `origin`）完全成立，TypeScript 不会对任何东西报错。

`VoicePilotBridge` 加：

```ts
  /** 第二个快捷键与选择器内 Esc 共用：phrases 态下语义是「关掉选择器」 */
  togglePhrases(): Promise<SessionSnapshot>;
  /** 选中一条常用语：切到 reviewing */
  usePhrase(): Promise<SessionSnapshot>;

  // —— 常用语 ——
  /** 常用语列表（最近使用优先） */
  phrasesList(): Promise<PhraseRow[]>;
  /** 存一条常用语，返回 {id} */
  phrasesSave(payload: { title: string; text: string }): Promise<{ id: number }>;
  /** 改标题/正文，返回是否命中一行 */
  phrasesUpdate(payload: { id: number; title: string; text: string }): Promise<boolean>;
  /** 删一条，返回是否真的删掉了 */
  phrasesDelete(id: number): Promise<boolean>;
  /** 记一次被选中（驱动「最近使用优先」）。调用方不该 await */
  phrasesTouch(id: number): Promise<boolean>;
  /** 读常用语快捷键。isDefault 表示未自定义 */
  getPhraseShortcut(): Promise<{ accel: string; isDefault: boolean }>;
  /** 设常用语快捷键。冲突时 ok:false 且不生效 */
  setPhraseShortcut(accel: string): Promise<{ ok: boolean; accel: string }>;
```

最后**核对** `adoptPolish` 的类型（Task 1 已经改好，此处只确认一致，**不要重复改**）：

```ts
  /**
   * 采用润色结果，回写历史。
   * id 显式传 null = 本次没有历史行（例如从常用语来的采纳），主进程**不会**回落；
   * 整个字段省略 = Studio 一路，主进程回落到 pendingHistoryId。
   */
  adoptPolish(payload: { id?: number | null; polished: string; scene: string; tone: string }): Promise<boolean>;
```

- [ ] **Step 8: 跑测试**

Run: `cd app && npm run typecheck && VP_STORE_SELFTEST=1 npx electron . && VP_SHORTCUT_SELFTEST=1 npx electron . && VP_SM_SELFTEST=1 npx electron . && VP_I18N_SELFTEST=1 npx electron . && npm run build && VP_UI_SELFTEST=1 npx electron .`
Expected: **五项全 `通过`、退出码全 0；typecheck 干净。**

界面自测也要跑，而且应当**绿**：本 Task 没改任何渲染层文件，`SessionSnapshot` 也**没有**加 `origin`（见 Step 7 的说明），所以 `run.tsx` 与 `App.tsx` 既不用改、也不应红。新增的桥方法对那两棵测试树无影响（`...real` 在类型上已提供全部方法，运行时也没人调它们）。

**如果这里界面自测红了**，说明改动溢出了主进程范围 —— 回去查，不要靠改测试掩盖。

- [ ] **Step 9: 提交**

```bash
git add app/electron/store.js app/electron/shortcut.js app/electron/ipc.js app/electron/main.js app/electron/preload.cjs app/src/global.d.ts app/electron/selftest/shortcut.js app/electron/selftest/store.js
git commit -m "feat(phrases): IPC 通道 + 第二个全局快捷键槽位 + phrases 态主动 focus"
```

---

### Task 6: 悬浮条内的选择器

**Files:**
- Modify: `app/src/App.tsx`
- Modify: `app/shared/i18n/{zh-CN,zh-TW,en-US}.js`
- Test: `app/src/uitest/run.tsx`

**Interfaces:**
- Consumes: Task 5 的桥方法 `phrasesList/phrasesTouch/togglePhrases/usePhrase`、`SessionSnapshot.origin`
- Produces: `data-testid="phrase-search"`、`"phrase-list"`、`"phrase-item"`、`"phrases-empty"`

- [ ] **Step 1: i18n 三语**

`zh-CN.js`（放在 `bar.err.noPresets` 之后）：

```js
  'bar.phrases.title': '常用语',
  'bar.phrases.searchPlaceholder': '搜索常用语',
  'bar.phrases.empty': '还没有常用语。在结果里点书签图标存一条。',
  'bar.phrases.noMatch': '没有匹配的常用语',
```

`zh-TW.js`：

```js
  'bar.phrases.title': '常用語',
  'bar.phrases.searchPlaceholder': '搜尋常用語',
  'bar.phrases.empty': '還沒有常用語。在結果裡點書籤圖示存一條。',
  'bar.phrases.noMatch': '沒有符合的常用語',
```

`en-US.js`：

```js
  'bar.phrases.title': 'Phrases',
  'bar.phrases.searchPlaceholder': 'Search phrases',
  'bar.phrases.empty': 'No phrases yet. Save one with the bookmark icon in the result.',
  'bar.phrases.noMatch': 'No matching phrases',
```

- [ ] **Step 2: App.tsx —— 类型、状态、加载、选中**

(a) 文件顶部两行 import 改成：

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// KeyboardEvent 要按类型单独引入并改名：写 React.KeyboardEvent 需要 React 命名空间
// （本文件没有 `import React`），而裸 KeyboardEvent 会被解析成 DOM 的全局类型。
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, Ref } from 'react';
```

(b) `SessionState` 加 `'phrases'`：

```tsx
type SessionState = 'idle' | 'warming' | 'listening' | 'draining' | 'reviewing' | 'phrases';
```

(c) `Snapshot` 加 `origin` —— **两处一起改，它们必须同步**：

先改共享声明 `app/src/global.d.ts`：

```ts
interface SessionSnapshot {
  state: 'idle' | 'warming' | 'listening' | 'draining' | 'reviewing' | 'phrases';
  notice: { kind: string; message: string; attempt: number; maxAttempts: number } | null;
  truncated: boolean;
  /** 本次 reviewing 的文本从哪来。常用语不落历史就靠它判（spec §2.3）。 */
  origin: 'dictation' | 'phrase';
}
```

> 这条改动是 Task 5 有意推迟到本 Task 的：它一落地，`App.tsx` 的本地镜像与 `run.tsx` 里 16 处 `fire('state',…)` 字面量会同时变红，而那些正是本 Task 要改的文件 —— 放在同一个 Task 里才能保证任何一次提交树都是干净的。

再改 `app/src/App.tsx` 的本地镜像（它 mirror 上面那个类型，`state` 联合与 `origin` 都要跟上）：

```tsx
interface Snapshot {
  state: SessionState;
  notice: Notice | null;
  truncated: boolean;
  origin: 'dictation' | 'phrase';
}
```

(d) `LABEL` 加一项：`phrases: t('bar.phrases.title'),`

(e) `snap` 初值补 `origin`：

```tsx
  const [snap, setSnap] = useState<Snapshot>({
    state: 'idle', notice: null, truncated: false, origin: 'dictation',
  });
```

(f) 新增状态（放在 `polishError` 之后）：

```tsx
  // 常用语选择器。phraseText 是「选中那条的正文」—— 按既有约定「文本归渲染进程
  // 所有」，它不进主进程，进 reviewing 时直接灌进编辑区。
  const [phraseText, setPhraseText] = useState<string | null>(null);
  const [phrases, setPhrases] = useState<PhraseRow[]>([]);
  const [phraseQuery, setPhraseQuery] = useState('');
  const [phraseIndex, setPhraseIndex] = useState(0);
```

(g) 新 ref（放在 `editorRef` 之后）：

```tsx
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
```

(h) 两个 effect（放在预设 effect 之后）：

```tsx
  // 进 phrases 态：拉一次列表、复位检索、把焦点给搜索框。
  // 聚焦依赖主进程那边已经 focus() 过窗口（见 ipc.js 的 emit）—— DOM focus 只决定
  // 键盘落在哪个元素上，窗口本身没被激活的话按键照样不来。
  useEffect(() => {
    if (snap.state !== 'phrases') return;
    setPhraseQuery('');
    setPhraseIndex(0);
    void vp.phrasesList().then(setPhrases).catch(() => setPhrases([]));
    searchRef.current?.focus();
  }, [snap.state, vp]);

  // 回 idle 清掉选中态，避免下一轮选择器带着上一条的正文。
  useEffect(() => {
    if (snap.state !== 'idle') return;
    setPhraseText(null);
    setPhraseQuery('');
    setPhraseIndex(0);
  }, [snap.state]);
```

(i) 过滤、键盘、选中（放在 `effectiveText` 之前）：

```tsx
  /** 输入即筛选：标题与正文都匹配。空查询返回全部（主进程已按最近使用排好）。 */
  const filteredPhrases = useMemo(() => {
    const q = phraseQuery.trim().toLowerCase();
    if (!q) return phrases;
    return phrases.filter(
      (p) => p.title.toLowerCase().includes(q) || p.text.toLowerCase().includes(q)
    );
  }, [phrases, phraseQuery]);

  // 查询变了把高亮拉回第一条，否则会停在一个已不存在的下标上。
  useEffect(() => {
    setPhraseIndex(0);
  }, [phraseQuery]);

  // 高亮项必须滚进可视区，否则键盘选到列表外时用户看不见。
  useEffect(() => {
    if (snap.state !== 'phrases') return;
    const el = listRef.current?.querySelectorAll('[data-testid="phrase-item"]')[phraseIndex];
    el?.scrollIntoView({ block: 'nearest' });
  }, [phraseIndex, filteredPhrases.length, snap.state]);

  /**
   * 选中一条：把正文交给编辑区（phraseText），记一次「被用过」，再让状态机切
   * reviewing。phrasesTouch **不 await** —— 它只影响下次排序，不该拖慢或挡住进态。
   */
  const selectPhrase = useCallback(
    (p: PhraseRow) => {
      setPhraseText(p.text);
      void vp.phrasesTouch(p.id);
      void vp.usePhrase();
    },
    [vp]
  );

  const onSearchKey = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      const list = filteredPhrases;
      if (e.key === 'ArrowDown') {
        // 必须 preventDefault：否则按键会带着窗口滚动
        e.preventDefault();
        setPhraseIndex((i) => Math.min(i + 1, Math.max(list.length - 1, 0)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setPhraseIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const p = list[phraseIndex];
        if (p) selectPhrase(p);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        void vp.togglePhrases();
      }
    },
    [filteredPhrases, phraseIndex, selectPhrase, vp]
  );
```

- [ ] **Step 3: 编辑区 seed、历史门禁、warming 复位**

(a) seed effect（原 `:314-316`）：

```tsx
  // reviewing 一进来把派生文本灌进编辑区；之后 edited 就是唯一真源。
  // 依赖数组**故意不含 fullText / phraseText** —— 含进去会在用户每次打字后重跑
  // 并覆盖编辑内容。常用语来的 reviewing 里 fullText 是空的，正文在 phraseText。
  useEffect(() => {
    if (snap.state === 'reviewing') setEdited(phraseText ?? fullText);
  }, [snap.state]);
```

(b) 历史落库 effect（原 `:356`）：在 `if (snap.state !== 'reviewing') return;` 之后插一行：

```tsx
    // 常用语采纳不落历史（spec §2.3）：它不是「这次听写」的产物，反复用同一条
    // 会在历史里刷屏，而它自己已经有管理页。判据来自状态机而不是本地启发式。
    if (snap.origin !== 'dictation') return;
```

**随之而来的已接受后果**：从常用语来的 reviewing 里点了「润色」再采纳，润色结果**不会**被持久化（没有历史行可写；Task 1 的 `resolvePolishTarget` 保证它不会写错行）。从常用语存的文本已经是成品，润色只是可选加工，故可接受。

(c) `warming` 复位块里补一行（与其它文本复位放一起）：`setPhraseText(null);`

- [ ] **Step 4: 渲染选择器**

把「reviewing 是可编辑面」那段三元改成三分支（**reviewing 与 else 两个分支的原内容一行不动**，只插前面一支）：

```tsx
      {/* phrases：常用语选择器（可聚焦、键盘驱动）；reviewing：可编辑面；
          其余态：只读展示（A2） */}
      {snap.state === 'phrases' ? (
        <>
          <input
            ref={searchRef}
            data-testid="phrase-search"
            style={styles.search}
            value={phraseQuery}
            onChange={(e) => setPhraseQuery(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder={t('bar.phrases.searchPlaceholder')}
          />
          <div ref={listRef} data-testid="phrase-list" style={styles.list}>
            {filteredPhrases.length === 0 ? (
              <div data-testid="phrases-empty" style={styles.listEmpty}>
                {phrases.length === 0 ? t('bar.phrases.empty') : t('bar.phrases.noMatch')}
              </div>
            ) : (
              filteredPhrases.map((p, i) => (
                <div
                  key={p.id}
                  data-testid="phrase-item"
                  data-active={i === phraseIndex}
                  style={styles.listItem(i === phraseIndex)}
                  onMouseEnter={() => setPhraseIndex(i)}
                  onClick={() => selectPhrase(p)}
                >
                  <div style={styles.listTitle}>{p.title}</div>
                  <div style={styles.listSnippet}>{p.text.replace(/\s+/g, ' ').slice(0, 60)}</div>
                </div>
              ))
            )}
          </div>
        </>
      ) : snap.state === 'reviewing' ? (
```

新增样式：

```tsx
  search: {
    flexShrink: 0,
    padding: '6px 8px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    background: '#ffffff',
    color: '#111827',
    fontFamily: 'inherit' as const,
    fontSize: 13,
    outline: 'none',
    userSelect: 'text' as const,
  },
  // 列表自己滚，不参与 flex:1 抢空间 —— 窗口高度有上限（BAR_MAX_HEIGHT），
  // 条目多时靠 maxHeight + overflow 兜住。
  list: {
    flexShrink: 0,
    maxHeight: 360,
    overflowY: 'auto' as const,
    scrollbarWidth: 'thin' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 2,
  },
  listItem: (active: boolean) => ({
    padding: '6px 8px',
    borderRadius: 6,
    cursor: 'pointer' as const,
    background: active ? '#eff6ff' : 'transparent',
  }),
  listTitle: {
    color: '#111827',
    fontSize: 13,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
  listSnippet: {
    color: '#9ca3af',
    fontSize: 11,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
  listEmpty: { color: '#9ca3af', padding: 12, textAlign: 'center' as const },
```

**同时必须放宽 `styles` 末尾的 `satisfies`**：`listItem` 是 `(active) => CSSProperties` 的函数，
而 App.tsx 现在是 `} satisfies Record<string, CSSProperties>;`，加了函数值会直接类型报错。
照 `HistoryView.tsx` 的写法改：

```tsx
} satisfies Record<string, CSSProperties | ((active: boolean) => CSSProperties)>;
```

- [ ] **Step 5: 高度 effect 把列表算进去**

```tsx
    // 内容元素：reviewing 是编辑区，phrases 是列表，其余态是只读文本区。
    const contentEl = editorRef.current ?? listRef.current ?? textRef.current;
```

依赖数组补：

```tsx
  }, [
    draft, committed, snap, error, copied, hint, edited,
    polishOut, polishing, polishError, vp,
    phraseQuery, phraseIndex, filteredPhrases.length,
  ]);
```

（`chrome` / `contentNeed` 那两行不动 —— `contentEl` 换成列表后它们自动成立。）

- [ ] **Step 6: 界面自测 —— 补 `origin` 并加选择器用例**

(a) **先把所有 `fire('state', {...})` 的对象字面量补上 `origin`**：TS 会把每一处漏掉的都标红，逐个补齐即可；除专门验常用语的用例外一律 `origin: 'dictation'`。顶部 `IDLE` 常量也要改：

```tsx
const IDLE = { state: 'idle', notice: null, truncated: false, origin: 'dictation' } as const;
```

(b) 新增 holder（放在 `adoptPasteCtl` 附近）：

```tsx
  const phraseSaveCtl: { payload: { title: string; text: string } | null } = { payload: null };
  let togglePhrasesCalls = 0;
  let usePhraseCalls = 0;
  const touchedIds: number[] = [];
  // 选择器列表由每条用例自己摆（顺序即主进程给的「最近使用优先」）。
  let phraseRows: PhraseRow[] = [];
```

(c) 假 `bridge` 加方法（放在 `adoptPolish` 之后）：

```tsx
    togglePhrases: () => {
      togglePhrasesCalls += 1;
      return Promise.resolve(IDLE);
    },
    usePhrase: () => {
      usePhraseCalls += 1;
      return Promise.resolve(IDLE);
    },
    phrasesList: () => Promise.resolve(phraseRows),
    phrasesTouch: (id: number) => {
      touchedIds.push(id);
      return Promise.resolve(true);
    },
    phrasesSave: (payload: { title: string; text: string }) => {
      phraseSaveCtl.payload = payload;
      return Promise.resolve({ id: 99 });
    },
```

(d) 新增第 25 段（放在第 24 段之后、算 `failed` 之前）：

```tsx
  // ---- 25. 常用语选择器：搜索 / 键盘导航 / Enter 选中 / Esc 关闭 / 占位 ----
  // 不能用 enterReviewing()：那条路会经过 warming 并把文本灌成 fullText。
  // 常用语一路是 idle → phrases，正文完全来自 phraseText。
  phraseRows = [
    { id: 1, title: '问候', text: '您好，收到您的反馈，我先看一下。', created_at: 2, updated_at: 2, used_at: null },
    { id: 2, title: '收尾', text: '有问题随时找我。', created_at: 1, updated_at: 1, used_at: null },
  ];
  const enterPhrases = async () => {
    fire('state', { state: 'idle', notice: null, truncated: false, origin: 'dictation' });
    await flush();
    fire('state', { state: 'phrases', notice: null, truncated: false, origin: 'dictation' });
    await waitFor(() => container.querySelector('[data-testid="phrase-item"]') != null);
    return container;
  };
  const items = () => Array.from(container.querySelectorAll('[data-testid="phrase-item"]'));
  const activeIndex = () => items().findIndex((n) => n.getAttribute('data-active') === 'true');

  await enterPhrases();
  // 「phrases 态绝不启动采集」（spec §1.6）：清掉标志位再进一次态，断言它保持 false。
  // 这是「不说话直接选一条」不产生任何识别费用的唯一证据。
  captureStarted = false;
  await enterPhrases();
  check('phrases 态不启动采集（不建 ASR 会话、不产生识别费用）',
    captureStarted === false, String(captureStarted));
  check('选择器渲染搜索框与两条常用语',
    container.querySelector('[data-testid="phrase-search"]') != null && items().length === 2,
    JSON.stringify(items().map((n) => n.textContent)));
  check('默认高亮第一条', activeIndex() === 0, String(activeIndex()));

  const search = container.querySelector<HTMLInputElement>('[data-testid="phrase-search"]');
  const typeSearch = (v: string) => {
    // 与 bar-editor 同一坑：React 在 input 上装了 value tracker，直接赋值会被
    // 认为「值没变」而不触发 onChange。必须走原型上的原生 setter。
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(search, v);
    search?.dispatchEvent(new Event('input', { bubbles: true }));
  };

  typeSearch('收尾');
  await flush();
  check('输入即筛选（标题命中）', items().length === 1, String(items().length));

  typeSearch('反馈');
  await flush();
  check('输入即筛选（正文也匹配）', items().length === 1, String(items().length));

  typeSearch('不存在的词');
  await flush();
  check('无匹配时显示占位、不显示条目',
    items().length === 0 && container.querySelector('[data-testid="phrases-empty"]') != null,
    JSON.stringify(container.querySelector('[data-testid="phrases-empty"]')?.textContent));

  typeSearch('');
  await flush();
  check('清空查询后恢复全部', items().length === 2, String(items().length));

  // 方向键：↓ 到第二条、↑ 回第一条
  search?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await flush();
  check('↓ 移到第二条', activeIndex() === 1, String(activeIndex()));
  search?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  await flush();
  check('↑ 回到第一条', activeIndex() === 0, String(activeIndex()));

  // Enter 选中：正文进编辑区、记一次 touch、状态机切 reviewing
  usePhraseCalls = 0;
  touchedIds.length = 0;
  search?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
  check('Enter 调了一次 usePhrase', usePhraseCalls === 1, String(usePhraseCalls));
  check('Enter 记了一次「被用过」（id 与高亮项一致）',
    JSON.stringify(touchedIds) === JSON.stringify([1]), JSON.stringify(touchedIds));

  fire('state', { state: 'reviewing', notice: null, truncated: false, origin: 'phrase' });
  await flush();
  const phraseEditor = () => container.querySelector<HTMLTextAreaElement>('[data-testid="bar-editor"]');
  check('选中后编辑区内容是那条常用语的正文（不是空的 fullText）',
    phraseEditor()?.value === '您好，收到您的反馈，我先看一下。',
    JSON.stringify(phraseEditor()?.value));

  // 「常用语不落历史」：origin=phrase 时**不得**调 historySave。
  historySaveCtl.payload = null;
  await flush();
  check('常用语来的 reviewing 不落历史（origin=phrase）',
    historySaveCtl.payload === null, JSON.stringify(historySaveCtl.payload));

  // 对照：听写来的 reviewing 必须落历史（否则上面那条可能只是因为 effect 没跑）
  await enterReviewing();
  check('听写来的 reviewing 照旧落历史（origin=dictation）',
    historySaveCtl.payload != null &&
      (historySaveCtl.payload as { text: string }).text.includes('今天我们要讨论三件事'),
    JSON.stringify(historySaveCtl.payload));

  // Esc 关闭选择器
  await enterPhrases();
  togglePhrasesCalls = 0;
  container
    .querySelector<HTMLInputElement>('[data-testid="phrase-search"]')
    ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await flush();
  check('Esc 调了一次 togglePhrases', togglePhrasesCalls === 1, String(togglePhrasesCalls));

  // 空库占位：给「去存一条」的引导，而不是「没有匹配」
  phraseRows = [];
  await enterPhrases();
  check('空库显示引导文案（不是「没有匹配」）',
    container.querySelector('[data-testid="phrases-empty"]')?.textContent ===
      '还没有常用语。在结果里点书签图标存一条。',
    JSON.stringify(container.querySelector('[data-testid="phrases-empty"]')?.textContent));
```

- [ ] **Step 7: 跑测试**

Run: `cd app && npm run build && VP_UI_SELFTEST=1 npx electron .`
Expected: 全部通过、退出码 0。

- [ ] **Step 8: 提交**

```bash
git add app/src/App.tsx app/shared/i18n app/src/uitest/run.tsx
git commit -m "feat(phrases): 悬浮条内的常用语选择器（搜索 / ↑↓ / Enter / Esc）"
```

---

### Task 7: 条内「存为常用语」

**Files:**
- Create: `app/src/phrases/title.ts`
- Modify: `app/src/App.tsx`
- Modify: `app/shared/i18n/{zh-CN,zh-TW,en-US}.js`
- Test: `app/src/uitest/run.tsx`

**Interfaces:**
- Produces: `derivePhraseTitle(text: string): string`（含 `PHRASE_TITLE_MAX = 40`）；`data-testid="bar-save-phrase"`

- [ ] **Step 1: 写纯函数**

新建 `app/src/phrases/title.ts`：

```ts
/**
 * 从正文派生选择器里那行短标签。
 *
 * 保存必须**零打断**（spec §0 决策 5），所以不起名、不弹输入框 —— 取正文的第一个
 * 非空行，超长截断。用户想改名去 Studio 的常用语页。
 *
 * 长度按码点算（Array.from）而不是 UTF-16 单元：否则一个 emoji 会被算成 2，
 * 中英混排时截断位置与用户看到的字符数对不上。
 */
export const PHRASE_TITLE_MAX = 40;

export function derivePhraseTitle(text: string): string {
  const firstLine = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstLine) return '';

  const chars = Array.from(firstLine);
  if (chars.length <= PHRASE_TITLE_MAX) return firstLine;
  return chars.slice(0, PHRASE_TITLE_MAX).join('') + '…';
}
```

- [ ] **Step 2: i18n 三语**

`zh-CN.js`：

```js
  'bar.savePhrase': '存为常用语',
  'bar.savedPhrase': '已存为常用语',
  'bar.savePhrase.fail': '没能存进常用语',
```

`zh-TW.js`：

```js
  'bar.savePhrase': '存為常用語',
  'bar.savedPhrase': '已存為常用語',
  'bar.savePhrase.fail': '沒能存進常用語',
```

`en-US.js`：

```js
  'bar.savePhrase': 'Save as phrase',
  'bar.savedPhrase': 'Saved as phrase',
  'bar.savePhrase.fail': 'Could not save the phrase',
```

- [ ] **Step 3: App.tsx —— 头部图标按钮**

import 加 `import { derivePhraseTitle } from './phrases/title';`

handler（放在 `openApp` 之后）：

```tsx
  /**
   * 存为常用语。存 effectiveText（有润色存润色，否则存手改后的原文）——
   * 与「采纳」同一口径：用户点了润色就是想让那段文本生效。
   *
   * 提示走 hint 而不是 error：它不是错误，且不该把 errorHold 的 5 秒停留卷进来。
   */
  const savePhrase = useCallback(() => {
    const text = effectiveText;
    if (text.trim().length === 0) return;
    void (async () => {
      try {
        await vp.phrasesSave({ title: derivePhraseTitle(text), text });
        setHint(t('bar.savedPhrase'));
      } catch {
        setHint(t('bar.savePhrase.fail'));
      }
    })();
  }, [effectiveText, vp, t]);
```

头部那一段改成放两个按钮，**只有最左那个带 `marginLeft:'auto'`**（否则两个都吃自动外边距，位置会错）：

```tsx
        {snap.state === 'reviewing' && (
          <>
            {/* 存为常用语。内联 SVG（14×14，无图标库依赖）：书签形状。
                marginLeft:'auto' 由它承担（它是最左的那个图标），把整组推到右端。 */}
            <button
              style={styles.iconButton}
              data-testid="bar-save-phrase"
              title={t('bar.savePhrase')}
              aria-label={t('bar.savePhrase')}
              onClick={savePhrase}
              disabled={effectiveText.trim().length === 0}
            >
              <svg
                width="14" height="14" viewBox="0 0 14 14" fill="none"
                stroke="currentColor" strokeWidth="1.4"
                strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
              >
                <path d="M3.5 2h7a1 1 0 011 1v9L7 9l-4.5 3V3a1 1 0 011-1z" />
              </svg>
            </button>
            <button
              style={styles.iconButtonNoAuto}
              data-testid="bar-open-app"
              title={t('bar.openApp')}
              aria-label={t('bar.openApp')}
              onClick={openApp}
            >
              {/* 原有「打开应用」SVG 原样保留 */}
            </button>
          </>
        )}
```

样式：`iconButton` 保留原样（带 `marginLeft:'auto'`），新增去掉它的那一份：

```tsx
  // 头部第二个图标：不承担 marginLeft:'auto'（那个由它左边那个负责），
  // 否则两个都吃自动外边距，间距和位置都会错。
  iconButtonNoAuto: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 4,
    borderRadius: 6,
    border: '1px solid #d1d5db',
    background: 'transparent',
    color: '#6b7280',
    cursor: 'pointer' as const,
    lineHeight: 0,
  },
```

- [ ] **Step 4: 界面自测断言**

`app/src/uitest/run.tsx` 顶部 import 加 `import { derivePhraseTitle } from '../phrases/title';`，然后在第 25 段之后新增第 26 段：

```tsx
  // ---- 26. 条内「存为常用语」：存入的是有效文本，且不打断 ----
  await enterReviewing();
  phraseSaveCtl.payload = null;
  // 制造「编辑区被改过、但没有润色结果」的局面，验证存的是编辑后的原文
  const ed2 = container.querySelector<HTMLTextAreaElement>('[data-testid="bar-editor"]');
  if (ed2) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(ed2, '第一行标题\n第二行正文');
    ed2.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await flush();

  const saveBtn = container.querySelector<HTMLButtonElement>('[data-testid="bar-save-phrase"]');
  check('reviewing 头部有「存为常用语」图标且 aria-label=title',
    saveBtn != null &&
      saveBtn.getAttribute('aria-label') === '存为常用语' &&
      saveBtn.getAttribute('title') === '存为常用语',
    JSON.stringify({ present: saveBtn != null, aria: saveBtn?.getAttribute('aria-label') }));

  // 位置回归护栏：与「打开应用」同一套理由 —— 必须不在动作行内、父节点是头部
  check('「存为常用语」不在动作行内、父节点是头部（位置回归护栏）',
    saveBtn?.closest('[data-testid="bar-actions"]') === null &&
      saveBtn?.parentElement === container.querySelector('[data-testid="bar-head"]'),
    JSON.stringify({
      insideActions: saveBtn?.closest('[data-testid="bar-actions"]') != null,
      parentIsHead: saveBtn?.parentElement === container.querySelector('[data-testid="bar-head"]'),
    }));

  saveBtn?.click();
  await waitFor(() => phraseSaveCtl.payload != null);
  const saved = phraseSaveCtl.payload as { title: string; text: string } | null;
  check('存的是编辑后的原文（无润色时）',
    saved?.text === '第一行标题\n第二行正文', JSON.stringify(saved));
  check('标题自动取第一个非空行', saved?.title === '第一行标题', JSON.stringify(saved?.title));
  check('保存成功给出轻提示（不关闭悬浮条、不占错误气泡）',
    container.querySelector('[data-testid="bar-hint-adopt"]')?.textContent === '已存为常用语' &&
      container.querySelector('[data-testid="bar-editor"]') != null,
    JSON.stringify(container.querySelector('[data-testid="bar-hint-adopt"]')?.textContent));

  // derivePhraseTitle 的边界（纯函数，直接验）
  check('derivePhraseTitle：空串 → 空', derivePhraseTitle('') === '', JSON.stringify(derivePhraseTitle('')));
  check('derivePhraseTitle：全空白 → 空',
    derivePhraseTitle('   \n\n  ') === '', JSON.stringify(derivePhraseTitle('   \n\n  ')));
  check('derivePhraseTitle：跳过前导空行取第一个非空行',
    derivePhraseTitle('\n\n  第二行才是标题  \n第三行') === '第二行才是标题',
    JSON.stringify(derivePhraseTitle('\n\n  第二行才是标题  \n第三行')));
  check('derivePhraseTitle：恰好 40 字符不截断',
    derivePhraseTitle('a'.repeat(40)) === 'a'.repeat(40));
  check('derivePhraseTitle：41 字符截断到 40 并补省略号',
    derivePhraseTitle('a'.repeat(41)) === 'a'.repeat(40) + '…',
    JSON.stringify(derivePhraseTitle('a'.repeat(41))));
```

- [ ] **Step 5: 跑测试**

Run: `cd app && npm run typecheck && npm run build && VP_UI_SELFTEST=1 npx electron .`
Expected: 全部通过、退出码 0。

- [ ] **Step 6: 提交**

```bash
git add app/src/phrases/title.ts app/src/App.tsx app/shared/i18n app/src/uitest/run.tsx
git commit -m "feat(phrases): 悬浮条头部「存为常用语」图标（一键存，标题取首行）"
```

---

### Task 8: Studio「常用语」页 + 设置页第二快捷键

**Files:**
- Create: `app/src/studio/PhrasesView.tsx`
- Modify: `app/src/studio/Studio.tsx`、`app/src/studio/SettingsView.tsx`
- Modify: `app/shared/i18n/{zh-CN,zh-TW,en-US}.js`
- Test: `app/src/uitest/run.tsx`

**Interfaces:**
- Consumes: `vp.phrasesList/phrasesSave/phrasesUpdate/phrasesDelete`、`vp.getPhraseShortcut/setPhraseShortcut`
- Produces: `data-testid="studio-nav-phrases"`、`"phrase-list-item"`、`"phrase-edit-title"`、`"phrase-edit-text"`、`"phrase-save"`、`"phrase-delete"`、`"phrase-new"`、`"settings-phrase-shortcut"`、`"settings-phrase-shortcut-record"`

- [ ] **Step 1: i18n 三语**

`zh-CN.js`：

```js
  'studio.phrases': '常用语',
  'phrase.title': '标题',
  'phrase.text': '内容',
  'phrase.listEmpty': '还没有常用语',
  'phrase.selectHint': '选中一条常用语查看或编辑',
  'phrase.save': '保存',
  'phrase.saved': '已保存',
  'phrase.delete': '删除',
  'phrase.new': '新建',
  'phrase.untitled': '未命名',
  'settings.phraseShortcut': '常用语快捷键',
  'settings.phraseShortcut.hint': '按下组合键即可修改唤起常用语的全局快捷键',
```

`zh-TW.js`：

```js
  'studio.phrases': '常用語',
  'phrase.title': '標題',
  'phrase.text': '內容',
  'phrase.listEmpty': '還沒有常用語',
  'phrase.selectHint': '選取一條常用語查看或編輯',
  'phrase.save': '儲存',
  'phrase.saved': '已儲存',
  'phrase.delete': '刪除',
  'phrase.new': '新增',
  'phrase.untitled': '未命名',
  'settings.phraseShortcut': '常用語快捷鍵',
  'settings.phraseShortcut.hint': '按下組合鍵即可修改喚起常用語的全域快捷鍵',
```

`en-US.js`：

```js
  'studio.phrases': 'Phrases',
  'phrase.title': 'Title',
  'phrase.text': 'Content',
  'phrase.listEmpty': 'No phrases yet',
  'phrase.selectHint': 'Select a phrase to view or edit',
  'phrase.save': 'Save',
  'phrase.saved': 'Saved',
  'phrase.delete': 'Delete',
  'phrase.new': 'New',
  'phrase.untitled': 'Untitled',
  'settings.phraseShortcut': 'Phrase shortcut',
  'settings.phraseShortcut.hint': 'Press a key combination to change the global phrase shortcut',
```

- [ ] **Step 2: PhrasesView.tsx**

新建 `app/src/studio/PhrasesView.tsx`：

```tsx
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useT } from '../i18n';

/**
 * 常用语管理（F14）。与 HistoryView 结构对称，但**不复用它** —— 那边是只读 +
 * 复制/润色，这边是编辑/删除/新建，硬塞会让两边都变形。
 *
 * 详情面板同时承担「新建」：没有选中项时点保存就是新增（同一个 vp.phrasesSave）。
 * 这比刻意禁止新建更省事，也让手写一条常用语成为可能。
 */
export default function PhrasesView({ bridge }: { bridge?: Window['voicepilot'] } = {}) {
  const vp = bridge ?? window.voicepilot;
  const t = useT();
  const [rows, setRows] = useState<PhraseRow[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void vp.phrasesList().then(setRows).catch(() => setRows([]));
  }, [vp]);

  const pick = (r: PhraseRow) => {
    setSelectedId(r.id);
    setTitle(r.title);
    setText(r.text);
    setSaved(false);
  };

  const startNew = () => {
    setSelectedId(null);
    setTitle('');
    setText('');
    setSaved(false);
  };

  const save = () => {
    if (text.trim().length === 0) return;
    void (async () => {
      // 标题留空就用占位名，避免选择器里出现一行空白
      const finalTitle = title.trim() || t('phrase.untitled');
      // 先取到本地常量再判空：selectedId 是 state，跨 await 之后 TS 的收窄会失效，
      // 直接写 `if (isNew) ... else { id: selectedId }` 在异步闭包里过不了类型检查。
      const id = selectedId;
      try {
        if (id == null) {
          const created = await vp.phrasesSave({ title: finalTitle, text });
          setSelectedId(created.id);
        } else {
          const ok = await vp.phrasesUpdate({ id, title: finalTitle, text });
          if (!ok) return;
        }
        setTitle(finalTitle);
        setRows(await vp.phrasesList());
        setSaved(true);
      } catch {
        /* 保存失败不弹窗：列表仍是真源，用户可重试 */
      }
    })();
  };

  const del = () => {
    if (selectedId == null) return;
    void (async () => {
      const ok = await vp.phrasesDelete(selectedId);
      if (!ok) return;
      setRows(await vp.phrasesList());
      startNew();
    })();
  };

  return (
    <div style={styles.page}>
      <aside style={styles.list}>
        <button data-testid="phrase-new" style={styles.newBtn} onClick={startNew}>
          {t('phrase.new')}
        </button>
        {rows.length === 0 && <div style={styles.empty}>{t('phrase.listEmpty')}</div>}
        {rows.map((r) => (
          <div
            key={r.id}
            data-testid="phrase-list-item"
            style={styles.item(selectedId === r.id)}
            onClick={() => pick(r)}
          >
            <div style={styles.itemTitle}>{r.title}</div>
            <div style={styles.itemSnippet}>{r.text.replace(/\s+/g, ' ').slice(0, 40)}</div>
          </div>
        ))}
      </aside>

      <main style={styles.detail}>
        <label style={styles.label} htmlFor="phrase-edit-title">{t('phrase.title')}</label>
        <input
          id="phrase-edit-title"
          data-testid="phrase-edit-title"
          style={styles.input}
          value={title}
          onChange={(e) => { setTitle(e.target.value); setSaved(false); }}
          placeholder={t('phrase.untitled')}
        />
        <label style={styles.label} htmlFor="phrase-edit-text">{t('phrase.text')}</label>
        <textarea
          id="phrase-edit-text"
          data-testid="phrase-edit-text"
          style={styles.textarea}
          value={text}
          onChange={(e) => { setText(e.target.value); setSaved(false); }}
        />
        <div style={styles.actions}>
          <button
            data-testid="phrase-save"
            style={styles.primary}
            onClick={save}
            disabled={text.trim().length === 0}
          >
            {t('phrase.save')}
          </button>
          {selectedId != null && (
            <button data-testid="phrase-delete" style={styles.danger} onClick={del}>
              {t('phrase.delete')}
            </button>
          )}
          {saved && <span style={styles.hint}>{t('phrase.saved')}</span>}
        </div>
      </main>
    </div>
  );
}

const styles = {
  page: { flex: 1, minHeight: 0, display: 'flex', background: '#ffffff', color: '#1f2937', fontSize: 13 },
  list: { width: 240, flexShrink: 0, overflowY: 'auto', borderRight: '1px solid #e5e7eb', padding: 8, boxSizing: 'border-box' },
  empty: { color: '#9ca3af', padding: 16, textAlign: 'center' },
  newBtn: {
    width: '100%', padding: '6px 10px', marginBottom: 8, boxSizing: 'border-box',
    borderRadius: 6, border: '1px dashed #d1d5db', background: 'transparent',
    color: '#374151', fontSize: 12, cursor: 'pointer',
  },
  item: (active: boolean) => ({
    padding: '8px 10px', marginBottom: 4, borderRadius: 6, cursor: 'pointer',
    boxSizing: 'border-box',
    background: active ? '#eff6ff' : 'transparent',
  }),
  itemTitle: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  itemSnippet: { color: '#9ca3af', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  detail: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', padding: 16, gap: 8, boxSizing: 'border-box' },
  label: { color: '#6b7280', fontSize: 12, flexShrink: 0 },
  input: {
    flexShrink: 0, padding: '6px 8px', borderRadius: 6, border: '1px solid #d1d5db',
    background: '#ffffff', color: '#111827', fontFamily: 'inherit', fontSize: 13, outline: 'none',
  },
  textarea: {
    flex: 1, minHeight: 0, padding: 10, borderRadius: 8, border: '1px solid #e5e7eb',
    background: '#fafafa', color: '#111827', fontFamily: 'inherit', fontSize: 13,
    lineHeight: 1.6, resize: 'none', outline: 'none',
  },
  actions: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  primary: { padding: '5px 14px', borderRadius: 6, border: '1px solid #1d4ed8', background: '#1d4ed8', color: '#ffffff', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  danger: { padding: '5px 14px', borderRadius: 6, border: '1px solid #fecaca', background: '#ffffff', color: '#dc2626', fontSize: 12, cursor: 'pointer' },
  hint: { color: '#6b7280', fontSize: 11 },
} satisfies Record<string, CSSProperties | ((active: boolean) => CSSProperties)>;
```

- [ ] **Step 3: Studio 导航**

`app/src/studio/Studio.tsx`：

```tsx
import PhrasesView from './PhrasesView';
```

```tsx
type View = 'polish' | 'history' | 'phrases' | 'settings';
```

`ICONS` 加一项（16 视口、1.5 stroke、currentColor，与悬浮条那个书签同形）：

```tsx
  phrases: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 2.5h8a1 1 0 011 1V14l-5-3.4L3 14V3.5a1 1 0 011-1z" />
    </svg>
  ),
```

`NAV`：在 `history` 与 `settings` 之间插入

```tsx
    { key: 'phrases', label: t('studio.phrases') },
```

导航按钮补 testid（既有三个没有，加上不影响它们）：

```tsx
          <button
            key={key}
            data-testid={`studio-nav-${key}`}
            style={styles.railButton(view === key)}
            onClick={() => setView(key)}
          >
```

内容 switch：

```tsx
        {view === 'polish' ? (
          <PolishView bridge={bridge} />
        ) : view === 'history' ? (
          <HistoryView bridge={bridge} />
        ) : view === 'phrases' ? (
          <PhrasesView bridge={bridge} />
        ) : (
          <SettingsView bridge={bridge} />
        )}
```

- [ ] **Step 4: SettingsView 槽位化**

`app/src/studio/SettingsView.tsx`：import 加 `useCallback`。

主渲染里原来的快捷键块改成两块：

```tsx
      <h2 style={{ ...styles.h2, marginTop: 16 }}>{t('settings.shortcut')}</h2>
      <ShortcutSetting vp={vp} slot="main" />

      <h2 style={{ ...styles.h2, marginTop: 16 }}>{t('settings.phraseShortcut')}</h2>
      <ShortcutSetting vp={vp} slot="phrases" />
```

`ShortcutSetting` 换成槽位版（原逻辑一行不改，只把读写、文案、testid 按槽位取出）：

```tsx
/**
 * 快捷键录制。点击后进入录制态，捕获下一个带修饰键的组合键。
 * 冲突（主进程注册失败）时显示提示且**不更新**界面上的当前键。
 *
 * 两个槽位（main / phrases）共用这套控件：录制期间挂起的是**整个** globalShortcut
 * （setShortcutSuspended 管的是全局开关），两个键一起挂起正是录制时要的行为。
 */
function ShortcutSetting({ vp, slot }: { vp: Window['voicepilot']; slot: 'main' | 'phrases' }) {
  const t = useT();
  const [accel, setAccel] = useState('');
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState('');

  const prefix = slot === 'phrases' ? 'settings-phrase-shortcut' : 'settings-shortcut';
  const hintKey = slot === 'phrases' ? 'settings.phraseShortcut.hint' : 'settings.shortcut.hint';
  const read = useCallback(
    () => (slot === 'phrases' ? vp.getPhraseShortcut() : vp.getShortcut()),
    [vp, slot]
  );
  const write = useCallback(
    (next: string) => (slot === 'phrases' ? vp.setPhraseShortcut(next) : vp.setShortcut(next)),
    [vp, slot]
  );

  useEffect(() => {
    let alive = true;
    void read().then((r) => { if (alive) setAccel(r.accel); }).catch(() => {});
    return () => { alive = false; };
  }, [read]);

  // 录制：只在 recording 时监听 keydown。Esc = 取消录制（不提交、直接退出录制态）；
  // 其余无法表达的键不提交，留在录制态等用户重按
  useEffect(() => {
    if (!recording) return;
    const onKey = async (e: KeyboardEvent) => {
      e.preventDefault();
      // Esc 是显式的取消路径：裸 Esc 无修饰键，acceleratorFromEvent 只会返回 null，
      // 若按「无法表达的键」处理会一直留在录制态（全局快捷键也一直被挂起）。
      if (e.key === 'Escape') {
        setError('');
        setRecording(false);
        return;
      }
      const next = acceleratorFromEvent(e);
      if (!next) {
        // 纯修饰键 / 无修饰键 / 媒体键等无法表达的键：不提交，留在录制态让用户重按
        setError(t('settings.shortcut.unsupported'));
        return;
      }
      setRecording(false);
      const r = await write(next).catch(() => ({ ok: false, accel }));
      if (r.ok) { setAccel(r.accel); setError(''); }
      else { setError(t('settings.shortcut.conflict')); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, write, t, accel]);

  // 录制期间挂起全局快捷键：OS 级快捷键在本应用窗口有焦点时照样触发，
  // preventDefault 拦不住 —— 不挂起的话，用户按下的组合键会被主进程当成
  // 一次听写，同时又被写进绑定。清理函数保证离开录制或组件卸载时一定恢复。
  useEffect(() => {
    if (!recording) return;
    void vp.suspendShortcut(true);
    return () => { void vp.suspendShortcut(false); };
  }, [recording, vp]);

  return (
    <div style={styles.block}>
      <div style={styles.statusRow}>
        <span data-testid={prefix} style={styles.label}>
          {recording ? t('settings.shortcut.recording') : accel}
        </span>
        <button
          data-testid={`${prefix}-record`}
          style={styles.button}
          onClick={() => { setError(''); setRecording(true); }}
        >
          {t('settings.shortcut.record')}
        </button>
      </div>
      {error && <span style={{ color: '#dc2626' }}>{error}</span>}
      <span style={styles.plain}>{t(hintKey)}</span>
    </div>
  );
}
```

**主槽位的 testid 仍是 `settings-shortcut` / `settings-shortcut-record`**，既有的第 21 / 21.5 / 22 段断言不受影响。

- [ ] **Step 5: 界面自测断言**

`app/src/uitest/run.tsx`：

先给 `studioBridge` 补常用语方法与 holder（**必须补全** —— `...real` 复制不到 contextBridge 的非枚举属性，缺了会让 `PhrasesView` 挂载时抛 TypeError，整轮崩在中间，这是本文件反复踩过的坑）：

```tsx
  const phraseCtl = {
    rows: [
      { id: 1, title: '问候', text: '您好，收到您的反馈。', created_at: 2, updated_at: 2, used_at: null },
    ] as PhraseRow[],
    saved: null as { title: string; text: string } | null,
    deleted: [] as number[],
  };
```

在 `studioBridge` 对象里加（**只要这四个**）：

```tsx
    phrasesList: () => Promise.resolve(phraseCtl.rows),
    phrasesSave: (p: { title: string; text: string }) => {
      phraseCtl.saved = p;
      phraseCtl.rows = [
        ...phraseCtl.rows,
        { id: 2, title: p.title, text: p.text, created_at: 3, updated_at: 3, used_at: null },
      ];
      return Promise.resolve({ id: 2 });
    },
    phrasesUpdate: () => Promise.resolve(true),
    phrasesDelete: (id: number) => {
      phraseCtl.deleted.push(id);
      phraseCtl.rows = phraseCtl.rows.filter((r) => r.id !== id);
      return Promise.resolve(true);
    },
```

**另外两个方法要加在 `settingsBridge`**（`run.tsx` 里那个独立对象，约 `:611`；它与 `studioBridge` 是两个独立的假桥，设置页用的是它）：

```tsx
    getPhraseShortcut: () => Promise.resolve({ accel: 'Ctrl+Alt+Space', isDefault: true }),
    setPhraseShortcut: (a: string) => Promise.resolve({ ok: true, accel: a }),
```

然后在**第 26 段之后、算 `failed` 之前**新增第 27 / 28 段（放这里是因为 `settingsBridge` 在本函数作用域内已于前面声明；放到 Studio 段后面会踩「声明前使用」）：

```tsx
  // ---- 27. Studio「常用语」页：列表 / 编辑 / 新建 / 删除 ----
  // 另起一棵树，与第 24 段同款理由：不让上面的容器状态互相干扰。
  const phContainer = document.createElement('div');
  document.body.appendChild(phContainer);
  createRoot(phContainer).render(<Studio bridge={studioBridge} />);
  await flush();

  const navPhrases = phContainer.querySelector<HTMLButtonElement>('[data-testid="studio-nav-phrases"]');
  check('Studio 导航有「常用语」一项',
    navPhrases != null && navPhrases.textContent?.includes('常用语') === true,
    JSON.stringify(navPhrases?.textContent));

  navPhrases?.click();
  await waitFor(() => phContainer.querySelector('[data-testid="phrase-list-item"]') != null);
  check('常用语页渲染出已有条目',
    phContainer.querySelectorAll('[data-testid="phrase-list-item"]').length === 1,
    String(phContainer.querySelectorAll('[data-testid="phrase-list-item"]').length));

  // 选中一条 → 详情回填
  phContainer.querySelector<HTMLElement>('[data-testid="phrase-list-item"]')?.click();
  await flush();
  check('选中后详情回填标题与正文',
    phContainer.querySelector<HTMLInputElement>('[data-testid="phrase-edit-title"]')?.value === '问候' &&
      phContainer.querySelector<HTMLTextAreaElement>('[data-testid="phrase-edit-text"]')?.value === '您好，收到您的反馈。',
    JSON.stringify({
      title: phContainer.querySelector<HTMLInputElement>('[data-testid="phrase-edit-title"]')?.value,
      text: phContainer.querySelector<HTMLTextAreaElement>('[data-testid="phrase-edit-text"]')?.value,
    }));

  // 删除
  phContainer.querySelector<HTMLButtonElement>('[data-testid="phrase-delete"]')?.click();
  await waitFor(() => phContainer.querySelectorAll('[data-testid="phrase-list-item"]').length === 0);
  check('删除后列表清空且调了 phrasesDelete',
    phraseCtl.deleted.includes(1) &&
      phContainer.querySelectorAll('[data-testid="phrase-list-item"]').length === 0,
    JSON.stringify(phraseCtl.deleted));

  // 新建：空表单 + 保存
  phraseCtl.saved = null;
  phContainer.querySelector<HTMLButtonElement>('[data-testid="phrase-new"]')?.click();
  await flush();
  check('新建时详情表单是空的、且没有删除按钮',
    phContainer.querySelector<HTMLInputElement>('[data-testid="phrase-edit-title"]')?.value === '' &&
      phContainer.querySelector('[data-testid="phrase-delete"]') == null);
  check('内容为空时保存禁用',
    phContainer.querySelector<HTMLButtonElement>('[data-testid="phrase-save"]')?.disabled === true);

  const phText = phContainer.querySelector<HTMLTextAreaElement>('[data-testid="phrase-edit-text"]');
  if (phText) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(phText, '手写的一条常用语');
    phText.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await flush();
  phContainer.querySelector<HTMLButtonElement>('[data-testid="phrase-save"]')?.click();
  await waitFor(() => phraseCtl.saved != null);
  check('新建保存调 phrasesSave（标题留空用占位名）',
    phraseCtl.saved?.text === '手写的一条常用语' && phraseCtl.saved?.title === '未命名',
    JSON.stringify(phraseCtl.saved));

  // ---- 28. 设置页出现第二块快捷键（主块不受影响）----
  const setContainer = document.createElement('div');
  document.body.appendChild(setContainer);
  createRoot(setContainer).render(<SettingsView bridge={settingsBridge} />);
  await waitFor(() => setContainer.querySelector('[data-testid="settings-phrase-shortcut"]') != null);
  check('设置页有常用语快捷键块，且主块与录制按钮都在',
    setContainer.querySelector('[data-testid="settings-phrase-shortcut"]') != null &&
      setContainer.querySelector('[data-testid="settings-phrase-shortcut-record"]') != null &&
      setContainer.querySelector('[data-testid="settings-shortcut"]') != null,
    JSON.stringify(setContainer.textContent));
```

- [ ] **Step 6: 跑测试**

Run: `cd app && npm run typecheck && npm run build && VP_UI_SELFTEST=1 npx electron . && VP_I18N_SELFTEST=1 npx electron .`
Expected: 全绿、退出码 0。

- [ ] **Step 7: 提交**

```bash
git add app/src/studio/PhrasesView.tsx app/src/studio/Studio.tsx app/src/studio/SettingsView.tsx app/shared/i18n app/src/uitest/run.tsx
git commit -m "feat(phrases): Studio 常用语管理页 + 设置页第二快捷键录入"
```

---

### Task 9: 文档同步 + 真机验证清单

**Files:**
- Create: `docs/common-phrases-test-runbook.md`
- Modify: `docs/plans/2026-09-05-voicepilot-prd.md`、`README.md`、`docs/superpowers/specs/2026-09-13-common-phrases-design.md`（§5 状态）

**Interfaces:** 无代码产物。

- [ ] **Step 1: 写 runbook**

新建 `docs/common-phrases-test-runbook.md`。体例照 `docs/adopt-injection-test-runbook.md`（那份可当模板）。必须包含下面全部用例，且每条都写清「预期」与「不成立时怎么办」：

````markdown
# 常用语真机验证清单

自动化能覆盖的都在 `VP_UI_SELFTEST` / `VP_SM_SELFTEST` 里。**本文件只列自动测不到的**：
键盘输入、窗口激活、全局快捷键、真实写回。Windows 与 macOS 各过一遍。

## 前置
- `cd app && npm run build && npx electron .`
- 先按 `docs/adopt-injection-test-runbook.md` 验完采纳写回（本期复用它）
- 先存两条常用语（说一句话 → reviewing → 点头部书签图标）

## 用例 1：选择器能拿到键盘（最高风险，spec §6 风险 1）
1. 光标放进记事本 / Word，按第二个快捷键（默认 Win `Ctrl+Alt+Space` / Mac `Alt+Shift+Space`）
2. **预期**：弹出选择器，**搜索框已获得键盘焦点** —— 直接敲字就出现在框里，不需要先点一下
3. 按 `↑`/`↓`：高亮移动，且**底层应用的内容没有跟着滚动**（preventDefault 生效）
4. **若不成立**（敲字没反应、必须先鼠标点搜索框）：macOS 面板接受键盘输入的假设被证伪。
   **停下来回到 spec §6 风险 1 改决策**（降级为纯鼠标点选），不要在实现里默默绕过。

## 用例 2：关掉选择器后焦点归还（spec §6 风险 3）
1. 光标在记事本里，按第二个快捷键打开选择器
2. 按 `Esc`
3. **预期**：选择器消失，**记事本重新是前台**，光标还在原位置，可直接继续打字
4. 反向确认：打开选择器后先点一下浏览器（让记事本在后台）再按 `Esc`
   → **焦点不应被拽回记事本**（闸门 `bar.isFocused()` 生效）
5. 回归：以上任何一步之后，**任务栏都不应冒出 VoicePilot 按钮**
   （`setFocusable` 的 frame change 不能抵消 `skipTaskbar`；见 09-11 的修复）

## 用例 3：存一条 → 选一条 → 写回
1. 说一句话进入 reviewing，头部书签图标可点；点它 → 条底出现「已存为常用语」
2. 关掉悬浮条，把光标放进 Word，按第二个快捷键
3. 挑中刚存的那条 → 弹回 reviewing 编辑区，正文就是那一条
4. 点「采纳」→ 文本插入 Word，光标留在 Word
5. 回 Studio 的「常用语」页确认：那条 `used_at` 更新了（下次排在最前）

## 用例 4：常用语**不**进历史
1. 记下 Studio 历史页当前的条目数
2. 用常用语走一遍「选中 → 采纳」
3. **预期**：历史条目数**不变**（常用语采纳不属于「这次听写」）
4. 对照：正常听写一遍 → 历史条目数 +1

## 用例 5：第二个快捷键的冲突与录制
1. 设置页把常用语键改成与主快捷键**相同**的值 → 预期提示「该快捷键已被占用」，且**主快捷键仍然可用**
2. 改成某个已被别的软件占用的组合 → 同样提示，且原短语键仍生效
3. 录制时按 `Esc` → 退出录制且不提交
4. 录制时按纯修饰键（如单独 `Ctrl`）→ 提示「这个按键不能用作快捷键」，留在录制态
5. 改成功后立刻按新键 → 能打开选择器（不需要重启）

## 用例 6：A2 回归（不能被本期破坏）
1. 光标在 Word 里持续打字，按**主**快捷键开始听写
2. **预期**：打字不中断、焦点不跳走（聆听三态仍不抢焦点）
3. 只有按住**第二个**快捷键时才抢焦点（那是它的用途）

## 用例 7：空态与边界
1. 在 Studio 里删光所有常用语，按第二个快捷键
   → 预期显示「还没有常用语。在结果里点书签图标存一条。」
2. 存一条超长文本（> 40 字的第一行）→ 选择器里标题被截断并带省略号，正文完整
3. 在 Studio 手写一条（标题留空）→ 保存后标题显示为「未命名」
````

- [ ] **Step 2: 同步 PRD**

`docs/plans/2026-09-05-voicepilot-prd.md`：按该文件既有 F 编号体例新增 F14「常用语」，包含：第二个全局快捷键（Win `Ctrl+Alt+Space` / Mac `Alt+Shift+Space`，可改）、选择器交互（搜索 / ↑↓ / Enter / Esc）、与场景语气不绑定、采纳路径复用 F5、管理入口在 Studio。**只写已交付的行为**。

- [ ] **Step 3: 同步 README**

`README.md`：在功能清单里补「常用语」，并补一行第二个快捷键的默认值；自测命令清单里若有列全的，确认 `VP_*_SELFTEST` 那一串没漏（本期没新增 selftest 入口，只扩了既有四个）。

- [ ] **Step 4: 回写 spec §5 状态表**

`docs/superpowers/specs/2026-09-13-common-phrases-design.md` §5 的表里，把「待实现落地后再改」的行标成已完成，并注明 commit 区间。

- [ ] **Step 5: 提交**

```bash
git add docs/common-phrases-test-runbook.md docs/plans/2026-09-05-voicepilot-prd.md README.md docs/superpowers/specs/2026-09-13-common-phrases-design.md
git commit -m "docs(phrases): 真机验证清单 + PRD F14 / README 同步"
```

---

## 收尾验证

全部 Task 完成后，在干净树上跑一遍（`cd app`）：

```bash
npm run typecheck
VP_I18N_SELFTEST=1 npx electron .
VP_STORE_SELFTEST=1 npx electron .
VP_SM_SELFTEST=1 npx electron .
VP_SHORTCUT_SELFTEST=1 npx electron .
VP_INJECT_SELFTEST=1 npx electron .
npm run build && VP_UI_SELFTEST=1 npx electron .
```

期望：**六项全绿、退出码全 0、typecheck 干净**。

然后按 `docs/common-phrases-test-runbook.md` 在 Windows 真机过一遍用例 1–7，并在 Mac 上过一遍
（Mac 那一轮与 Plan 2B 的 macOS 验证合并执行 —— 用户 2026-09-13 决定不做 spike、直接实现）。

## 本计划不含（留给后续）

- 占位符 / 模板变量（spec §0.1 第 1 条）
- 常用语与场景/语气绑定、按场景分组（第 2 条）
- 重复去重（第 3 条）
- 跨设备同步（第 4 条）
- 从历史页把一条记录「提升」为常用语（第 5 条）
- 选择器失焦自动关闭（第 6 条）
- 撞键时的注册状态显示（spec §0.2 代价 1 —— 用户当前选择是不做）
- macOS 若实测键盘不可用，退化为纯鼠标点选（spec §6 风险 1；**退之前先改 spec 决策表**）
