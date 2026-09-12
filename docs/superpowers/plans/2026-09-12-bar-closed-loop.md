# 悬浮条内闭环（Plan 2A）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在不离开目标应用的前提下，于悬浮条内完成「编辑 → 润色 → 采纳/复制」闭环（试用反馈第①条）。

**Architecture:** 悬浮条在进入 `reviewing` 态时由主进程切成可聚焦（聆听期保持不可聚焦，"不打断"不破），文本区变为可编辑 textarea，下方是 5 个按钮 + 默认折叠的场景/语气区；点「润色」时上下分栏，下半为流式润色结果。文本真源从 `committed[]` 派生一次到 `edited` state，之后以 `edited` 为准（复制/落库/送润色都用它）。**本计划不含真正的写回注入**——「采纳」以「复制 + 明确提示手动粘贴」落地，注入是 Plan 2B。

**Tech Stack:** Electron 44（内置 Node 24）、React 19 + TS（Vite）、`node:sqlite`、自建自测（无第三方框架）。

## Global Constraints

- 平台：Windows 与 macOS 同等对待。
- 测试无第三方框架：主进程 `cd app && VP_<NAME>_SELFTEST=1 npx electron .`；渲染进程 `cd app && npm run build && VP_UI_SELFTEST=1 npx electron .`（**必须先 build**——界面自测加载 `app/dist/renderer` 产物）；`cd app && npm run typecheck` 必须干净。
- i18n 三语齐全（`app/shared/i18n/{zh-CN,zh-TW,en-US}.js`），**不得在组件里硬编码中文**；`VP_I18N_SELFTEST` 会强制三语 key 一致。
- **不引入任何原生模块**（本计划无此需求，务必保持 `app/package.json` 运行时依赖仍只有 `opencc-js` + `ws`）。
- **A2 不能破**：`warming / listening / draining` 三态窗口必须保持 `focusable:false` 且不抢焦点；只有 `reviewing` 可聚焦，且**不得调用 `focus()`**（用户点击才拿焦点）。
- 状态只有一个源头：五态由主进程状态机持有（`app/electron/session/machine.js`），渲染进程只订阅。
- 提交粒度：每个 Task 结束提交一次。

---

### Task 1: 主进程——reviewing 态切可聚焦 + 尺寸上限放宽

**Files:**
- Modify: `app/electron/main.js`（`BAR_MAX_HEIGHT` 常量、`createBar()`）
- Modify: `app/electron/ipc.js`（`emit` 助手）
- Modify: `app/src/App.tsx`（`BAR_MAX_HEIGHT` 常量）

**Interfaces:**
- Consumes: 既有 `getBar()`（ipc.js 已有）、状态机的 `vp:state` 广播
- Produces: 无新导出；行为契约 = 悬浮条 `focusable` 随状态机状态翻转

- [ ] **Step 1: 放宽高度上限**

`app/electron/main.js`：

```js
// 长文本时悬浮条自动长高的上限。避免一句说太长把窗口拉得变形。
// reviewing 态还要放编辑区 + 5 个按钮 + 折叠区（+ 润色分栏），420 装不下。
const BAR_MAX_HEIGHT = 620;
```

`app/src/App.tsx` 同步：

```js
const BAR_MAX_HEIGHT = 620;
```

- [ ] **Step 2: 让 `focusable` 跟着状态走**

在 `app/electron/ipc.js` 的 `emit` 助手里，发送 `vp:state` 时一并调整窗口可聚焦性：

```js
  const emit = (channel, payload) => {
    const bar = getBar();
    if (!bar || bar.isDestroyed()) return;
    // 只有 reviewing 需要键盘输入（编辑区）。聆听三态必须保持不可聚焦，
    // 否则「不抢焦点」（A2）就破了 —— 那是这个程序最硬的约束。
    // 注意这里**不调用 focus()**：切成可聚焦只是允许用户点击进来。
    if (channel === 'vp:state') {
      bar.setFocusable(payload?.state === 'reviewing');
    }
    bar.webContents.send(channel, payload);
  };
```

- [ ] **Step 3: 类型检查 + 回归**

Run: `cd app && npm run typecheck`
Expected: 干净通过

Run: `cd app && VP_SM_SELFTEST=1 npx electron .`
Expected: 29/29 通过，退出码 0

> ⚠️ **本步的正确性无法自动验**：`setFocusable` 是窗口属性，自测里没有真的悬浮条窗口。Windows 侧预期直接可用；**macOS 侧是本 Task 最大的未知**——悬浮条在 macOS 上是 `type:'panel'` + Nonactivating，`setFocusable(true)` 之后能否真正接受键盘输入，必须真机确认。若不能，先记录实测现象并停下找设计者（备选是把 panel 换成普通窗口，那会重新牵扯"不抢焦点"，不能擅自改）。见收尾验证第 7 项。

- [ ] **Step 4: Commit**

```bash
git add app/electron/main.js app/electron/ipc.js app/src/App.tsx
git commit -m "feat(bar): reviewing 态切可聚焦 + 高度上限放宽到 620"
```

---

### Task 2: store 增加历史文本更新 + IPC + 自测

编辑后文本会与「进入 reviewing 时落库的原文」不一致，需要能更新同一条。现有 `updateHistoryPolish` 只改润色字段。

**Files:**
- Modify: `app/electron/store.js`（历史区）
- Modify: `app/electron/selftest/store.js`
- Modify: `app/electron/ipc.js`（历史区）
- Modify: `app/electron/preload.cjs`、`app/src/global.d.ts`

**Interfaces:**
- Produces:
  - `store.updateHistoryText(id: number, text: string): void`
  - IPC `vp:history/update-text` ← `{ id, text }` → `true`
  - bridge `historyUpdateText(payload: { id: number; text: string }): Promise<boolean>`

- [ ] **Step 1: 先写失败断言**

`app/electron/selftest/store.js` **不使用** `check()` 助手，而是把布尔量 `okXxx` 汇总进末尾的 `const ok = ...`。照它的既有模式：

顶部 import 列表加入 `updateHistoryText`。

在末尾 `const ok = ...` 之前插入（**自建一条新记录**，不要复用文件前面那条 —— 它随后会被 deleteHistory 删掉，`getHistory` 会拿到 null）：

```js
  // 编辑后更新同一条历史的正文（不改 id / duration_ms / created_at）
  const { id: editId } = saveHistory({ text: '原始正文', durationMs: 1000 });
  updateHistoryText(editId, '改过的正文');
  const edited = getHistory(editId);
  const okUpdateText =
    edited?.text === '改过的正文' &&
    edited?.id === editId &&
    edited?.duration_ms === 1000;
```

把 `okUpdateText` 接进 `const ok = ...` 链与末尾 `console.log` 汇总。

- [ ] **Step 2: 运行，确认失败**

Run: `cd app && VP_STORE_SELFTEST=1 npx electron .`
Expected: 退出码非 0（导入未导出的 `updateHistoryText` → undefined，调用即抛）

- [ ] **Step 3: 实现 store 函数**

`app/electron/store.js`，紧挨 `updateHistoryPolish` 之后：

```js
/** 编辑后更新正文。只改 text，不动 id / created_at / 润色字段。 */
export function updateHistoryText(id, text) {
  openStore();
  db.prepare('UPDATE history SET text = ? WHERE id = ?').run(text, id);
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `cd app && VP_STORE_SELFTEST=1 npx electron .`
Expected: 通过，退出码 0（汇总里出现 `更新正文=true`）

- [ ] **Step 5: 加 IPC 与桥**

`app/electron/ipc.js`（历史区，`vp:history/delete` 之后）：

```js
  /** 编辑后更新同一条历史的正文。悬浮条在采纳/复制/关闭时调用。 */
  ipcMain.handle('vp:history/update-text', (_e, { id, text }) => {
    const n = Number(id);
    if (!Number.isFinite(n)) return false;
    updateHistoryText(n, String(text ?? ''));
    return true;
  });
```

该文件顶部 `./store.js` 的 import 行加入 `updateHistoryText`。

`app/electron/preload.cjs`（`historyDelete` 之后）：

```js
  /** 编辑后更新同一条历史的正文。 */
  historyUpdateText(payload) {
    return ipcRenderer.invoke('vp:history/update-text', payload);
  },
```

`app/src/global.d.ts`（`historyDelete` 之后）：

```ts
  /** 编辑后更新同一条历史的正文 */
  historyUpdateText(payload: { id: number; text: string }): Promise<boolean>;
```

- [ ] **Step 6: 类型检查**

Run: `cd app && npm run typecheck`
Expected: 干净通过

- [ ] **Step 7: Commit**

```bash
git add app/electron/store.js app/electron/selftest/store.js app/electron/ipc.js app/electron/preload.cjs app/src/global.d.ts
git commit -m "feat(history): 编辑后更新同一条历史的正文 + IPC"
```

---

### Task 3: 悬浮条润色所需的 IPC（预设 + 事件路由）

现状：`vp:polish/start` 把流式事件**只发给主应用窗口**（`getStudioWindow()`），悬浮条收不到。另外悬浮条需要场景/语气预设与默认场景。

**Files:**
- Modify: `app/electron/ipc.js`（润色区）
- Modify: `app/electron/preload.cjs`、`app/src/global.d.ts`

**Interfaces:**
- Produces:
  - IPC `vp:polish/presets` → `{ scenes: Preset[]; tones: Preset[]; defaultSceneId: number | null }`
  - `vp:polish/start` 载荷新增可选 `target: 'bar' | 'studio'`（缺省 `'studio'`，保持既有行为）
  - bridge `polishPresets(): Promise<{ scenes: Preset[]; tones: Preset[]; defaultSceneId: number | null }>`
  - bridge `startPolish(payload: { text; scene; tone; target?: 'bar' | 'studio' })`

- [ ] **Step 1: 加预设通道**

`app/electron/ipc.js` 润色区，`vp:polish/start` 之前：

```js
  /**
   * 悬浮条润色所需的预设。与 vp:studio/sync 同款数据，但不带文本 ——
   * 悬浮条的文本归渲染进程所有，不需要（也不应该）经过主进程转发。
   */
  ipcMain.handle('vp:polish/presets', () => {
    const locale = getCurrentLocale();
    return {
      scenes: listPresets('scene', locale),
      tones: listPresets('tone', locale),
      defaultSceneId: getMeta('default_scene_id') ? Number(getMeta('default_scene_id')) : null,
    };
  });
```

- [ ] **Step 2: 让 `vp:polish/start` 支持路由到悬浮条**

把现有 `vp:polish/start` 的 handler 替换为：

```js
  ipcMain.handle('vp:polish/start', async (_e, { text, scene, tone, target }) => {
    // last-used 默认场景：记住本次润色用的场景 id（稳定，不随 locale 变），
    // 下次打开默认选中。独立 try 避免影响润色本身。
    try { if (scene?.id != null) setMeta('default_scene_id', scene.id); } catch {}

    // 事件发给发起方所在窗口。悬浮条内润色（target='bar'）必须回到悬浮条，
    // 否则流式结果发到主应用窗口，悬浮条下半栏永远空白。
    const win = target === 'bar' ? getBar() : getStudioWindow();
    const emit = (channel, payload) => win?.webContents.send(channel, payload);

    try {
      await streamPolish({
        text, scene, tone,
        onDelta: (d) => emit('vp:polish/delta', { text: d }),
        onDone: () => emit('vp:polish/done', {}),
        onError: (e) => emit('vp:polish/error', { message: e.message }),
      });
    } catch (e) {
      emit('vp:polish/error', { message: e?.message ?? String(e) });
    }
    return true;
  });
```

- [ ] **Step 3: 暴露到 bridge 与类型**

`app/electron/preload.cjs`（`listPresets` 之后）：

```js
  /** 悬浮条润色所需的预设（不含文本）。 */
  polishPresets() {
    return ipcRenderer.invoke('vp:polish/presets');
  },
```

`app/src/global.d.ts`（`syncStudio` 之后）：

```ts
  /** 悬浮条润色所需的预设（不含文本） */
  polishPresets(): Promise<{ scenes: Preset[]; tones: Preset[]; defaultSceneId: number | null }>;
```

并把 `startPolish` 的类型改为：

```ts
  /** 发起润色。流式结果经 onPolishDelta/onPolishDone/onPolishError 回传 */
  startPolish(payload: { text: string; scene: Preset; tone: Preset; target?: 'bar' | 'studio' }): Promise<boolean>;
```

- [ ] **Step 4: 类型检查 + 回归**

Run: `cd app && npm run typecheck`
Expected: 干净通过

Run: `cd app && npm run build && VP_UI_SELFTEST=1 npx electron .`
Expected: 60/60 通过，退出码 0（主应用润色路径未被破坏）

- [ ] **Step 5: Commit**

```bash
git add app/electron/ipc.js app/electron/preload.cjs app/src/global.d.ts
git commit -m "feat(polish): 悬浮条润色所需的预设通道 + 事件路由到发起窗口"
```

---

### Task 4: 悬浮条 reviewing 态改为可编辑 + 按钮集 + 场景/语气折叠区

**Files:**
- Modify: `app/src/App.tsx`
- Modify: `app/shared/i18n/zh-CN.js`、`zh-TW.js`、`en-US.js`
- Test: `app/src/uitest/run.tsx`

**Interfaces:**
- Consumes: `historyUpdateText`（Task 2）、`polishPresets`（Task 3）、`setFocusable` 行为（Task 1）
- Produces: reviewing 态渲染 `data-testid="bar-editor"`（textarea）、`data-testid="bar-adopt"`、`data-testid="bar-open-app"`、`data-testid="bar-advanced-toggle"`、`data-testid="bar-scene"`、`data-testid="bar-tone"`

- [ ] **Step 1: 加三语文案**

`app/shared/i18n/zh-CN.js`（`bar.copied` 之后）追加：

```js
  'bar.adopt': '采纳',
  'bar.openApp': '打开应用',
  'bar.advanced': '润色选项',
  'bar.adopt.fallback': '已复制到剪贴板，请手动粘贴（自动写回尚未实现）',
```

`app/shared/i18n/zh-TW.js`：

```js
  'bar.adopt': '採納',
  'bar.openApp': '開啟應用',
  'bar.advanced': '潤色選項',
  'bar.adopt.fallback': '已複製到剪貼簿，請手動貼上（自動寫回尚未實作）',
```

`app/shared/i18n/en-US.js`：

```js
  'bar.adopt': 'Apply',
  'bar.openApp': 'Open app',
  'bar.advanced': 'Polish options',
  'bar.adopt.fallback': 'Copied to clipboard — paste it manually (auto-insert not implemented yet)',
```

- [ ] **Step 2: 写失败断言（先跑，确认红）**

在 `app/src/uitest/run.tsx` 的 `runUiTest()` 里、`const failed = results.filter(...)` **之前**追加：

```tsx
  // ---- 22. 悬浮条内闭环：可编辑 + 按钮集 + 折叠区 ----
  await enterReviewing();
  const barEditor = () => container.querySelector<HTMLTextAreaElement>('[data-testid="bar-editor"]');
  check('reviewing 渲染可编辑区', barEditor() != null);
  check('编辑区初值为全文（每句一行）',
    barEditor()?.value === '今天我们要讨论三件事\n第一件是采集\n第二件是识别\n第三件是润色',
    JSON.stringify(barEditor()?.value));

  const barButtons = () => Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
  check('按钮集为 润色/复制/采纳/打开应用/关闭',
    ['润色', '复制', '采纳', '打开应用', '关闭'].every((l) => barButtons().includes(l)),
    JSON.stringify(barButtons()));

  check('折叠区默认折叠：看不到场景下拉',
    container.querySelector('[data-testid="bar-scene"]') === null);
  const advToggle = container.querySelector<HTMLButtonElement>('[data-testid="bar-advanced-toggle"]');
  check('折叠区有展开按钮', advToggle != null);
  advToggle?.click();
  await flush();
  check('展开后出现场景/语气下拉',
    container.querySelector('[data-testid="bar-scene"]') != null &&
      container.querySelector('[data-testid="bar-tone"]') != null);

  // 编辑 → 复制，复制内容必须是**编辑后**的文本
  copyCtl.text = null;
  const ed = barEditor();
  if (ed) {
    ed.value = '我改过的文本';
    ed.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await flush();
  clickButton('复制');
  await flush();
  check('复制取编辑后的文本', copyCtl.text === '我改过的文本', JSON.stringify(copyCtl.text));
```

该断言块开头用到的 `entry` 与 `enterReviewing()` 需要先加：本文件已有「走到 reviewing 并拿到容器」的既有流程（第 5/6 节的 `fire('partial', ...)` + `fire('state', {state:'reviewing'})`）。把那段流程抽成局部函数并用它进入 reviewing，避免与既有块互相干扰：

```tsx
  // 进入一次干净的 reviewing：先回 idle 清场，再喂四句定稿 + 切 reviewing
  const enterReviewing = async () => {
    fire('state', { state: 'idle', notice: null, truncated: false });
    await flush();
    fire('state', { state: 'warming', notice: null, truncated: false });
    await flush();
    fire('state', { state: 'listening', notice: null, truncated: false });
    for (const text of ['今天我们要讨论三件事', '第一件是采集', '第二件是识别', '第三件是润色']) {
      fire('partial', { text, sentenceEnd: true, recvAtMs: Date.now() });
    }
    fire('state', { state: 'reviewing', notice: null, truncated: false });
    await flush();
    return container;
  };
```

`copyCtl` 若尚不存在，按本文件既有的 holder-object 模式加（`const copyCtl: { text: string | null } = { text: null };`），并在假 bridge 的 `copy` 里记录入参后再委托 `real.copy`。

- [ ] **Step 3: 实现 App.tsx 的 reviewing 态**

要点（照此实现，不要改其它态的行为）：

1. 新增 state：`const [edited, setEdited] = useState('');`、`const [advancedOpen, setAdvancedOpen] = useState(false);`、`const [scenes, setScenes] = useState<Preset[]>([]);`、`const [tones, setTones] = useState<Preset[]>([]);`、`const [scene, setScene] = useState<Preset | null>(null);`、`const [tone, setTone] = useState<Preset | null>(null);`、`const [hint, setHint] = useState('');`
2. `warming` 复位块里追加：`setEdited(''); setAdvancedOpen(false); setHint('');`
3. 进入 `reviewing` 时初始化编辑区（只初始化一次）：

```tsx
  // reviewing 一进来把派生文本灌进编辑区；之后 edited 就是唯一真源。
  // 依赖数组**故意不含 fullText** —— 含进去会在用户每次打字后重跑并覆盖编辑内容。
  useEffect(() => {
    if (snap.state === 'reviewing') setEdited(fullText);
  }, [snap.state]);
```

4. 拉预设（进入 reviewing 时，且只在没有时拉）：

```tsx
  useEffect(() => {
    if (snap.state !== 'reviewing' || scenes.length > 0) return;
    void vp.polishPresets().then((p) => {
      setScenes(p.scenes);
      setTones(p.tones);
      setScene(p.scenes.find((x) => x.id === p.defaultSceneId) ?? p.scenes[0] ?? null);
      setTone((prev) => prev ?? p.tones[0] ?? null);
    });
  }, [snap.state, scenes.length, vp]);
```

5. `copy` 改用 `edited`：

```tsx
  const copy = useCallback(async () => {
    const ok = await vp.copy(edited);
    ...
  }, [edited, vp, t]);
```

6. **落库更新**：在 `采纳 / 复制 / 关闭` 三个动作里，若 `edited` 与初次落库的原文不同则更新同一条。加一个共用函数：

```tsx
  const persistEdited = useCallback(async () => {
    const id = historyIdRef.current;
    if (id == null) return;
    if (edited.trim().length === 0) return;
    try { await vp.historyUpdateText({ id, text: edited }); } catch { /* 落库失败不阻塞主流程 */ }
  }, [edited, vp]);
```

7. reviewing 态的文本区：把现有的只读 `div[data-testid="text"]` **改为**在 reviewing 时渲染 textarea，其余态仍渲染原来的只读展示：

```tsx
      {snap.state === 'reviewing' ? (
        <textarea
          data-testid="bar-editor"
          style={styles.editor}
          value={edited}
          onChange={(e) => setEdited(e.target.value)}
          placeholder={t('polish.placeholder')}
        />
      ) : (
        <div ref={textRef} style={styles.text} data-testid="text">
          {paragraphs.map((lines, i) => (
            <span key={i}>
              {lines.join('')}
              {i < paragraphs.length - 1 ? '\n' : ''}
            </span>
          ))}
          {draft && <span style={styles.draft}>{draft}</span>}
        </div>
      )}
```

8. reviewing 态的按钮行改为五按钮 + 折叠区：

```tsx
      {snap.state === 'reviewing' && (
        <>
          <div style={styles.actions}>
            <button style={styles.button} data-testid="bar-polish" onClick={runPolish}
              disabled={edited.trim().length === 0}>
              {t('bar.polish')}
            </button>
            <button style={styles.button} data-testid="bar-copy" onClick={copy}
              disabled={edited.length === 0}>
              {t('bar.copy')}
            </button>
            <button style={styles.button} data-testid="bar-adopt" onClick={adopt}
              disabled={edited.trim().length === 0}>
              {t('bar.adopt')}
            </button>
            <button style={styles.ghost} data-testid="bar-open-app" onClick={openApp}>
              {t('bar.openApp')}
            </button>
            <button style={styles.ghost} onClick={() => void close()}>
              {t('bar.close')}
            </button>
            {snap.truncated && <span style={styles.warn}>{t('bar.truncated')}</span>}
          </div>
          <div style={styles.advanced}>
            <button style={styles.ghost} data-testid="bar-advanced-toggle"
              onClick={() => setAdvancedOpen((v) => !v)}>
              {t('bar.advanced')}
            </button>
            {advancedOpen && (
              <>
                <select style={styles.select} data-testid="bar-scene"
                  value={scene?.name ?? ''}
                  onChange={(e) => setScene(scenes.find((p) => p.name === e.target.value) ?? null)}>
                  {scenes.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
                </select>
                <select style={styles.select} data-testid="bar-tone"
                  value={tone?.name ?? ''}
                  onChange={(e) => setTone(tones.find((p) => p.name === e.target.value) ?? null)}>
                  {tones.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
                </select>
              </>
            )}
          </div>
        </>
      )}
```

9. `openApp` / `close` / `adopt` 三个处理函数（`adopt` 在 Task 5 补齐润色分支，本 Task 先按"复制 + 回退提示"实现）：

```tsx
  const openApp = useCallback(() => {
    void persistEdited();
    void vp.openStudio({ text: edited, historyId: historyIdRef.current ?? undefined });
    void vp.toggle();
  }, [edited, persistEdited, vp]);

  const close = useCallback(() => {
    void persistEdited();
    void vp.toggle();
  }, [persistEdited, vp]);

  // 本 Task 只做「复制 + 明确提示」；真正的写回（取前台窗口 → 还原焦点 → 粘贴）
  // 是 Plan 2B。用户明确接受这个中间形态：UI 闭环先成立，注入后补。
  const adopt = useCallback(async () => {
    await persistEdited();
    const ok = await vp.copy(edited);
    if (ok) {
      setCopied(true);
      setHint(t('bar.adopt.fallback'));
      return;
    }
    showError({ kind: 'clipboard', message: t('bar.err.clipboard') });
  }, [edited, persistEdited, vp, t]);
```

⚠️ **不要把 `adopt` 塞进 `ERROR_TEXT`。** 现有渲染是 `ERROR_TEXT[error.kind] ?? error.message`，加一个空字符串会命中 `??` 的左侧（空串不是 nullish），提示会渲染成**空白**。回退提示走独立的 `hint` state（中性文案，不是错误），在渲染末尾加：

```tsx
      {hint && <div style={styles.hint}>{hint}</div>}
```

`hint` 的复位与其他一次性状态一致：`warming` 复位块里 `setHint('')`，并在 `runPolish` 开头也清一次。Task 5 的 `adopt` 里同样用 `setHint(...)` 而不是 `showError({kind:'adopt'})`。

10. **`runPolish` 本 Task 只立骨架**（真正的流式润色是 Task 5，这样每个 Task 都能独立编译通过）：

```tsx
  // 悬浮条内润色在 Task 5 实现。本 Task 先把按钮立起来并保证点了有反应：
  // 缺预设时展开折叠区让用户先选。Task 5 会用真正的流式润色替换这段。
  const runPolish = useCallback(() => setAdvancedOpen(true), []);
```

10. 新增样式键：`editor`（等宽区域，`flex:1, minHeight:0, overflowY:auto, resize:none, border, borderRadius, padding, fontFamily:inherit, userSelect:text`）与 `advanced`（`display:flex, alignItems:center, gap:8, flexShrink:0`）、`select`（同 SettingsView 的下拉风格）。

- [ ] **Step 4: 运行，确认通过**

Run: `cd app && npm run typecheck`
Expected: 干净通过

Run: `cd app && npm run build && VP_UI_SELFTEST=1 npx electron .`
Expected: 全部通过，退出码 0

- [ ] **Step 5: Commit**

```bash
git add app/src/App.tsx app/shared/i18n/zh-CN.js app/shared/i18n/zh-TW.js app/shared/i18n/en-US.js app/src/uitest/run.tsx
git commit -m "feat(bar): reviewing 态可编辑 + 五按钮 + 场景语气折叠区"
```

---

### Task 5: 悬浮条内润色（上下分栏）+ 采纳取润色结果

**Files:**
- Modify: `app/src/App.tsx`
- Test: `app/src/uitest/run.tsx`

**Interfaces:**
- Consumes: `startPolish({ ..., target: 'bar' })`、`onPolishDelta/Done/Error`（Task 3）、`adoptPolish`（既有）
- Produces: `data-testid="bar-editor"`（上半，可编辑）、`data-testid="bar-polish-output"`（下半，只读）

- [ ] **Step 1: 写失败断言**

在 `app/src/uitest/run.tsx` 的 `runUiTest()` 里、`const failed = results.filter(...)` 之前追加（沿用 Task 4 的假 bridge 模式；`startPolish` 需记录载荷并暴露 delta/done/error 的触发句柄）：

```tsx
  // ---- 23. 悬浮条内润色：上下分栏 + 流式 + 采纳取润色结果 ----
  await enterReviewing();
  polishCall.payload = null;
  clickButton('润色');
  await flush();
  check('悬浮条发起的润色带 target=bar',
    polishCall.payload?.target === 'bar', JSON.stringify(polishCall.payload));
  check('点润色后出现下半结果区',
    container.querySelector('[data-testid="bar-polish-output"]') != null);
  check('润色中「润色」按钮禁用',
    container.querySelector<HTMLButtonElement>('[data-testid="bar-polish"]')?.disabled === true);

  barPolishDelta.cb?.({ text: '润色后的' });
  barPolishDelta.cb?.({ text: '第一句' });
  await flush();
  check('润色 delta 追加到下半区',
    container.querySelector('[data-testid="bar-polish-output"]')?.textContent === '润色后的第一句',
    JSON.stringify(container.querySelector('[data-testid="bar-polish-output"]')?.textContent));

  barPolishDone.cb?.();
  await flush();
  copyCtl.text = null;
  adoptCall.payload = null;
  clickButton('采纳');
  await flush();
  check('采纳取润色结果（不是编辑区原文）', copyCtl.text === '润色后的第一句', JSON.stringify(copyCtl.text));
  check('采纳把润色结果回写历史',
    adoptCall.payload?.polished === '润色后的第一句', JSON.stringify(adoptCall.payload));
```

该块需要：假 bridge 的 `startPolish` 记录载荷（含 `target`）；`onPolishDelta/onPolishDone/onPolishError` 暴露 `barPolishDelta.cb` / `barPolishDone.cb` / `barPolishError.cb`；`adoptPolish` 记录载荷。照本文件既有的 `studioDelta` / `polishCall` / `adoptCall` 写法加悬浮条这一套（可与 Studio 的假 bridge 共用同一个桥对象，但**监听器要多播**：悬浮条与 Studio 可能同时订阅，单播 mock 会互相覆盖）。

- [ ] **Step 2: 运行，确认失败**

Run: `cd app && npm run build && VP_UI_SELFTEST=1 npx electron .`
Expected: 失败（找不到 `bar-polish-output`），退出码非 0

- [ ] **Step 3: 实现分栏与采纳**

`app/src/App.tsx`：

1. 新增 state：`const [polishOut, setPolishOut] = useState('');`、`const [polishing, setPolishing] = useState(false);`、`const [polishError, setPolishError] = useState<string | null>(null);`
2. `warming` 复位块追加：`setPolishOut(''); setPolishing(false); setPolishError(null);`
3. 订阅流式事件（与 Studio 同款）：

```tsx
  useEffect(() => {
    const offDelta = vp.onPolishDelta(({ text: d }) => setPolishOut((prev) => prev + d));
    const offDone = vp.onPolishDone(() => setPolishing(false));
    const offError = vp.onPolishError(({ message }) => {
      setPolishError(message);
      setPolishing(false);
    });
    return () => { offDelta(); offDone(); offError(); };
  }, [vp]);
```

4. 发起润色：

```tsx
  const runPolish = useCallback(() => {
    if (!scene || !tone) {
      setAdvancedOpen(true); // 没选预设就把折叠区打开，别让按钮点了没反应
      return;
    }
    setPolishOut('');
    setPolishError(null);
    setHint('');
    setPolishing(true);
    void vp.startPolish({ text: edited, scene, tone, target: 'bar' });
  }, [edited, scene, tone, vp]);
```

5. 「当前有效文本」= 有润色结果就用润色结果，否则用编辑区：

```tsx
  const effectiveText = polishOut.length > 0 ? polishOut : edited;
```

6. 把 Task 4 留下的 `runPolish` 骨架**替换**为真正的实现（见上面 Step 3 第 4 点），并把 `bar-polish` 按钮改为反映润色中状态：

```tsx
            <button style={styles.button} data-testid="bar-polish" onClick={runPolish}
              disabled={edited.trim().length === 0 || polishing}>
              {polishing ? t('polish.running') : t('bar.polish')}
            </button>
```

7. `copy` 与 `adopt` 都改用 `effectiveText`；`adopt` 额外回写历史润色字段：

```tsx
  const adopt = useCallback(async () => {
    await persistEdited();
    if (polishOut.length > 0) {
      try {
        await vp.adoptPolish({ polished: polishOut, scene: scene?.name ?? '', tone: tone?.name ?? '' });
      } catch { /* 回写失败不阻塞采纳 */ }
    }
    const ok = await vp.copy(effectiveText);
    if (ok) {
      setCopied(true);
      setHint(t('bar.adopt.fallback'));
      return;
    }
    showError({ kind: 'clipboard', message: t('bar.err.clipboard') });
  }, [effectiveText, polishOut, persistEdited, scene, tone, vp, t]);
```

7. 下半区渲染（在 `bar-editor` 之后、按钮行之前）：

```tsx
      {snap.state === 'reviewing' && (polishing || polishOut.length > 0 || polishError) && (
        <div data-testid="bar-polish-output" style={styles.output}>
          {polishError ? t('polish.errorPrefix') + polishError : polishOut}
        </div>
      )}
```

8. 新增样式键 `output`（同 `editor` 的边框/内边距，但底色略深、`overflowY:auto`、`userSelect:text`，且 `flex:'0 0 auto'` 以免把编辑区压没）。

- [ ] **Step 4: 运行，确认通过**

Run: `cd app && npm run typecheck`
Expected: 干净通过

Run: `cd app && npm run build && VP_UI_SELFTEST=1 npx electron .`
Expected: 全部通过，退出码 0

Run: `cd app && VP_SM_SELFTEST=1 npx electron .`
Expected: 29/29 通过

- [ ] **Step 5: Commit**

```bash
git add app/src/App.tsx app/src/uitest/run.tsx
git commit -m "feat(bar): 悬浮条内润色上下分栏 + 采纳取润色结果"
```

---

### Task 6: 文档同步

**Files:**
- Modify: `docs/plans/2026-09-05-voicepilot-prd.md`（§4.1 / §4.3）
- Modify: `docs/superpowers/specs/2026-09-12-trial-feedback-design.md`（§1 改动面 / §3 悬浮条交互）

**Interfaces:** 无代码接口

- [ ] **Step 1: 更新 PRD**

§4.1（悬浮条形态）与 §4.3（复制）改为：`reviewing` 态文本区可编辑；按钮为 润色/复制/采纳/打开应用/关闭；场景与语气在默认折叠的高级区里选择；**采纳当前实现为「复制 + 明确提示手动粘贴」**，真正的写回目标应用见 Plan 2B（尚未实现）。不要改写其它小节。

- [ ] **Step 2: 更新设计文档**

§1 的改动面里，把 `app/src/studio/PolishView.tsx` 那行改为「润色 UI 逻辑复用到悬浮条」的实际落点说明；§3.2 的按钮与折叠区描述与实现对齐；并在 §2 注明「本批只做回退路径，注入在 Plan 2B」。

- [ ] **Step 3: Commit**

```bash
git add docs/plans/2026-09-05-voicepilot-prd.md docs/superpowers/specs/2026-09-12-trial-feedback-design.md
git commit -m "docs: 同步悬浮条内闭环的实现形态（采纳暂为回退路径）"
```

---

## 收尾验证

- [ ] `cd app && npm run typecheck`
- [ ] `cd app && VP_STORE_SELFTEST=1 npx electron .`
- [ ] `cd app && VP_I18N_SELFTEST=1 npx electron .`
- [ ] `cd app && VP_SM_SELFTEST=1 npx electron .`
- [ ] `cd app && VP_SHORTCUT_SELFTEST=1 npx electron .`
- [ ] `cd app && npm run build && VP_UI_SELFTEST=1 npx electron .`
- [ ] 真机（Win + macOS 各一次）：口述几句 → 确认进 reviewing 后**能点进编辑区打字**；聆听期**仍然不抢焦点**（在别的应用里打字不被抢）；润色分栏可用；采纳给出「已复制，请手动粘贴」提示；复制的是编辑后的文本。

## 本计划不含（留给 Plan 2B）

真正的「采纳 → 写回触发时所在的目标应用」：取前台窗口 → 还原焦点 → 发 Ctrl/Cmd+V → 失败回退。它需要先选定注入路线（原生模块 vs OS 脚本），会单独成篇。
