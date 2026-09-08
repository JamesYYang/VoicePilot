# 移除「职业」维度 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除「职业」维度（F8 选职业 + 职业→default_scene 映射），替换为欢迎页 + last-used 默认场景。

**Architecture:** 欢迎页是独立 `#onboarding` 窗口，只介绍快捷键与权限、不提问；「已看过」复用 `meta.first_run_done`，在窗口 `closed` 事件统一写入。默认场景改为「上次润色用的场景」，在 `vp:polish/start` 主进程 handler 里写 `meta.default_scene`，渲染层零改动。ASR 词表本期留空不变，仅同步 PRD 描述。

**Tech Stack:** Electron 44 + React 19 + TypeScript（`tsc --noEmit`）+ `node:sqlite`（`meta` 键值表）。

## Global Constraints

- 复用 `meta.first_run_done` 作欢迎页「已看过」标记，**不新增** meta 键。
- `meta.default_scene` 语义改为 last-used；`meta.profession` 废弃、不迁移、不清理旧值。
- 渲染层 `app/src/studio/PolishView.tsx` **零改动**（last-used 写入在主进程完成）。
- 不引入新依赖。
- 测试命令：
  - store 自测：`cd app && VP_STORE_SELFTEST=1 npx electron .`（跑完自动退出，exit 0/1）
  - 类型检查：`cd app && npm run typecheck`

## File Structure

| 文件 | 责任 | 变化 |
|---|---|---|
| `app/electron/store.js` | 内置预设播种 | `BUILTIN_SCENES` 顺序：文档置顶 |
| `app/electron/selftest/store.js` | store 自测 | 加「文档首位」断言 |
| `app/src/onboarding/Onboarding.tsx` | 引导窗口 UI | 三档职业按钮 → 欢迎页 |
| `app/electron/preload.cjs` | 渲染层桥 | 删 `saveOnboarding` |
| `app/src/global.d.ts` | 桥类型 | 删 `saveOnboarding` |
| `app/electron/ipc.js` | IPC handler | 删 `vp:onboarding/save`；`vp:polish/start` 加 last-used |
| `app/electron/onboarding.js` | 引导窗口 | `closed` 写 `first_run_done` |
| `app/electron/main.js` | 启动逻辑 | 欢迎页默认启用 |
| `docs/plans/2026-09-05-voicepilot-prd.md` | 产品文档 | F8 / §5.3 / §9 同步 |

---

### Task 1: 默认场景「文档」置顶

**Files:**
- Modify: `app/electron/store.js:13`
- Modify: `app/electron/selftest/store.js`

**Interfaces:**
- Consumes: `listPresets('scene')`（已存在，返回 `{id,name,description,is_builtin}[]`，按 `sort_order,id` 升序）
- Produces: 无新接口。后续任务依赖「`BUILTIN_SCENES` 首项为 `文档`」这一事实（首次无记录时 `PolishView` 回退 `scenes[0]`）。

- [ ] **Step 1: 写失败断言**

在 `app/electron/selftest/store.js` 的 `runStoreSelftest` 中，`okSeed` 声明后加一行：

```js
  const okDocFirst = scenes[0]?.name === '文档';
```

把末尾 `ok` 与 `console.log` 两处改为带上它：

```js
  const ok = okSeed && okWrite && okUpdate && okAdd && okEdit && okBuiltinKeep && okDel && okMeta && okDocFirst;
  console.log(`[自测] ${ok ? '通过' : '失败'} 播种=${okSeed} 写=${okWrite} 更新=${okUpdate} 增=${okAdd} 改=${okEdit} 内置不删=${okBuiltinKeep} 删=${okDel} meta=${okMeta} 文档首位=${okDocFirst}`);
```

- [ ] **Step 2: 跑自测验证失败**

Run: `cd app && VP_STORE_SELFTEST=1 npx electron .`
Expected: 输出 `失败 ... 文档首位=false`，进程 exit 1（当前 `BUILTIN_SCENES` 首项是「邮件」）。

- [ ] **Step 3: 改播种顺序**

`app/electron/store.js:13`：

```js
const BUILTIN_SCENES = ['文档', '邮件', '即时通讯', '社媒'];
```

- [ ] **Step 4: 跑自测验证通过**

Run: `cd app && VP_STORE_SELFTEST=1 npx electron .`
Expected: 输出 `通过 ... 文档首位=true`，exit 0。

- [ ] **Step 5: Commit**

```bash
git add app/electron/store.js app/electron/selftest/store.js
git commit -m "feat(store): 默认场景「文档」置顶，首次无记录默认文档"
```

---

### Task 2: 欢迎页重写 + 删除职业保存链路

**Files:**
- Modify: `app/src/onboarding/Onboarding.tsx`（整文件重写）
- Modify: `app/electron/preload.cjs:234-238`
- Modify: `app/src/global.d.ts:107-108`
- Modify: `app/electron/ipc.js:226-231`

**Interfaces:**
- Consumes: `vp.closeOnboarding(): Promise<boolean>`（已存在，`preload.cjs` 的 `closeOnboarding` → `ipc.js` 的 `vp:onboarding/close`，关窗）
- Produces: 欢迎页渲染后仅调用 `closeOnboarding`；`saveOnboarding` 从桥、类型、IPC 三处删除，不再存在。

- [ ] **Step 1: 重写 `Onboarding.tsx` 为欢迎页**

用以下完整内容替换 `app/src/onboarding/Onboarding.tsx`：

```tsx
import type { CSSProperties } from 'react';

/**
 * 首次使用欢迎页（F8）。不提问，只介绍快捷键与权限，点「开始使用」关窗。
 * 「已看过」标记（first_run_done）由主进程在窗口关闭时写入（见 onboarding.js）。
 */
export default function Onboarding({ bridge }: { bridge?: Window['voicepilot'] } = {}) {
  const vp = bridge ?? window.voicepilot;
  const isMac = navigator.userAgent.includes('Mac');
  const shortcut = isMac ? '⌥Space' : 'Ctrl+Shift+Space';
  const permission = isMac
    ? '请在系统设置中允许「麦克风」权限，并在「隐私与安全性 → 辅助功能」中允许 VoicePilot（全局快捷键需要）。'
    : '首次使用请在系统设置中允许「麦克风」权限。';

  return (
    <div style={styles.page}>
      <h1 style={styles.title}>欢迎使用 VoicePilot 闻字</h1>
      <p style={styles.line}>
        按 <b style={styles.key}>{shortcut}</b> 开始语音输入，说完自动生成文字，可一键复制或润色。
      </p>
      <p style={styles.hint}>{permission}</p>
      <button style={styles.primary} onClick={() => void vp.closeOnboarding()}>
        开始使用
      </button>
    </div>
  );
}

const styles = {
  page: { height: '100vh', boxSizing: 'border-box', padding: 24, display: 'flex', flexDirection: 'column', gap: 14, background: '#ffffff', color: '#1f2937', fontSize: 13 },
  title: { margin: 0, fontSize: 16, fontWeight: 600 },
  line: { margin: 0, lineHeight: 1.6 },
  key: { fontFamily: 'monospace', background: '#f3f4f6', padding: '2px 6px', borderRadius: 4 },
  hint: { margin: 0, color: '#6b7280', fontSize: 12, lineHeight: 1.6 },
  primary: { alignSelf: 'flex-start', padding: '8px 20px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontSize: 13, cursor: 'pointer' },
} satisfies Record<string, CSSProperties>;
```

- [ ] **Step 2: 删 `preload.cjs` 的 `saveOnboarding`**

删除 `app/electron/preload.cjs` 中这段（保留紧随其后的 `closeOnboarding`）：

```js
  /** 记录首次引导选择。 */
  saveOnboarding(payload) {
    return ipcRenderer.invoke('vp:onboarding/save', payload);
  },
```

- [ ] **Step 3: 删 `global.d.ts` 的 `saveOnboarding` 接口**

删除 `app/src/global.d.ts` 中这行（保留下一行 `closeOnboarding`）：

```ts
  /** 记录首次引导选择（职业），返回是否成功 */
  saveOnboarding(payload: { profession: string }): Promise<boolean>;
```

- [ ] **Step 4: 删 `ipc.js` 的 `vp:onboarding/save` handler**

删除 `app/electron/ipc.js` 中这段（保留紧随其后的 `vp:onboarding/close`）：

```js
  /** 记录首次引导选择：职业 + 场景默认值 + 首次标志。 */
  ipcMain.handle('vp:onboarding/save', (_e, { profession }) => {
    setMeta('profession', profession);
    setMeta('default_scene', profession === 'product_rd' ? '文档' : '邮件');
    setMeta('first_run_done', 'true');
    return true;
  });
```

- [ ] **Step 5: 类型检查**

Run: `cd app && npm run typecheck`
Expected: 通过，无错误。若报 `uitest/run.tsx` 或其它文件的 `saveOnboarding` 引用，删掉对应 mock 字段后再跑（预期没有，因 `run.tsx` 无 onboarding 引用）。

- [ ] **Step 6: 手工看欢迎页（旧触发条件下）**

Run: `cd app && VP_ENABLE_ONBOARDING=1 npm start`
Expected: 弹出欢迎页，显示快捷键说明与「开始使用」按钮，点按钮关窗。（此时仍走旧触发条件，Task 3 才改为默认启用。）

- [ ] **Step 7: Commit**

```bash
git add app/src/onboarding/Onboarding.tsx app/electron/preload.cjs app/src/global.d.ts app/electron/ipc.js
git commit -m "feat(onboarding): 欢迎页替换选职业，移除职业保存链路"
```

---

### Task 3: 欢迎页默认启用（首次弹一次）

**Files:**
- Modify: `app/electron/onboarding.js:1-3,36-38`
- Modify: `app/electron/main.js:390-396`

**Interfaces:**
- Consumes: `setMeta(key, value)`（`store.js` 已导出）、`getMeta(key)`（`main.js` 已 import）
- Produces: 欢迎页在首次启动（`first_run_done !== 'true'`）时弹出；窗口关闭即写 `first_run_done='true'`。

- [ ] **Step 1: `onboarding.js` import `setMeta`**

在 `app/electron/onboarding.js` 顶部 import 区加一行（现有 import 后）：

```js
import { setMeta } from './store.js';
```

- [ ] **Step 2: `closed` 事件写标记**

把 `app/electron/onboarding.js` 里的：

```js
  win.on('closed', () => {
    win = null;
  });
```

改为：

```js
  win.on('closed', () => {
    setMeta('first_run_done', 'true');
    win = null;
  });
```

- [ ] **Step 3: `main.js` 默认启用**

把 `app/electron/main.js` 里的：

```js
  // 首次启动引导窗（F8）—— 暂缓启用（2026-09-06）。
  // 原因：引导的职业选择当前只影响润色默认场景，原设计「职业 → 两组提示词」
  // （ASR 提示词 + 润色提示词）尚未实现，弹出来问的问题基本没实际效果，先隐藏。
  // 代码全部保留（onboarding.js / Onboarding.tsx / vp:onboarding/* IPC 未删），
  // 想临时开出来测试：VP_ENABLE_ONBOARDING=1 npm start。
  if (process.env.VP_ENABLE_ONBOARDING === '1' && getMeta('first_run_done') !== 'true') {
    createOnboardingWindow({ attachDevLogging });
  }
```

改为：

```js
  // 首次启动引导窗（F8）—— 欢迎页：快捷键 + 权限提示。首次启动弹一次，之后不再弹。
  if (getMeta('first_run_done') !== 'true') {
    createOnboardingWindow({ attachDevLogging });
  }
```

- [ ] **Step 4: 类型检查**

Run: `cd app && npm run typecheck`
Expected: 通过。

- [ ] **Step 5: 手工验证首次弹、二次不弹**

Run: `cd app && npm start`
Expected: 弹出欢迎页 → 点「开始使用」关窗 → 完全退出应用（托盘退出）→ 再次 `npm start` → **不再弹**欢迎页。
若要复测「首次」，可临时删 `userData/voicepilot.db`（或把 `meta.first_run_done` 改回非 true）后重跑。

- [ ] **Step 6: Commit**

```bash
git add app/electron/onboarding.js app/electron/main.js
git commit -m "feat(onboarding): 欢迎页默认启用，首次启动弹一次"
```

---

### Task 4: 润色时记录 last-used 默认场景

**Files:**
- Modify: `app/electron/ipc.js:186-188`

**Interfaces:**
- Consumes: `setMeta(key, value)`（`ipc.js` 已 import）、`scene`（`vp:polish/start` 的入参 `{text, scene, tone}`，`scene` 为 `Preset`，含 `.name`）
- Produces: `meta.default_scene` 被写为本次润色的场景名；`syncStudio`（`ipc.js:160` 已读 `getMeta('default_scene')`）据此给 `PolishView` 提供默认场景。

- [ ] **Step 1: `vp:polish/start` 加 last-used 写入**

在 `app/electron/ipc.js` 的 `vp:polish/start` handler 内、`const win = getStudioWindow();` 之前插入（独立 try，写失败不污染润色）：

```js
    // last-used 默认场景：记住本次润色用的场景，下次打开默认选中。独立 try 避免影响润色本身。
    try { setMeta('default_scene', scene?.name ?? ''); } catch {}
```

- [ ] **Step 2: 类型检查**

Run: `cd app && npm run typecheck`
Expected: 通过。

- [ ] **Step 3: 手工验证 last-used**

Run: `cd app && npm start`
Expected: 打开主应用润色工作区 → 场景下拉选「邮件」→ 输入文本点「润色」→ 关闭主应用窗口 → 托盘菜单重新打开润色工作区 → 场景下拉**默认选中「邮件」**。再选「即时通讯」润色一次 → 重开 → 默认变「即时通讯」。

- [ ] **Step 4: Commit**

```bash
git add app/electron/ipc.js
git commit -m "feat(polish): 润色时记录 last-used 默认场景"
```

---

### Task 5: 同步 PRD

**Files:**
- Modify: `docs/plans/2026-09-05-voicepilot-prd.md`

**Interfaces:**
- Consumes: 无。
- Produces: PRD 与代码一致——F8 为欢迎页、§5.3 词表与职业解绑、§9「职业 → 两组提示词」标记已放弃。

- [ ] **Step 1: 改 F8 里程碑表行（第 102 行）**

把：

```md
| F8 | 首次使用引导 | 选职业 → 设场景默认值；**默认「通用」，可跳过**。ASR 词表本期留空（专名表待 M6 产出后经 F11 下发）。**暂缓启用**——「职业 → 两组提示词」未定，代码保留待重新接入 |
```

改为：

```md
| F8 | 首次使用引导 | 欢迎页（快捷键 + 权限提示 + 「开始使用」），首次启动弹一次。**不再选职业**；默认场景改为 last-used（记住上次润色用的场景） |
```

- [ ] **Step 2: 重写 §4.0 首次使用引导段落（第 130-147 行）**

读取第 130-147 行原文（含「只问一个问题」「同时驱动两层」等表格），整段替换为：

```md
安装后首次启动，弹欢迎页（F8），**不提问**：只介绍全局快捷键（macOS `⌥Space` / Windows `Ctrl+Shift+Space`）、麦克风权限提示，点「开始使用」关窗，之后不再弹。

首次无记录时，润色默认场景为「文档」；之后记住上次润色使用的场景（last-used），不再由「职业」推断。
```

- [ ] **Step 3: 改 §5.3 词表清单说明（第 329-333 行附近）**

读取词表清单表格，把「通用（无词表）｜**默认**」的说明保留，但删除任何「职业 → 词表」绑定表述（若有），并在表格后补一句：

```md
词表与「职业」解绑：内部专名表全体共享，经 F11 默认下发（M6 起），不再由用户自报职业决定加载哪份。
```

- [ ] **Step 4: 改 §9 开放问题（第 600 行）**

把第 600 行的「**「职业 → 两组提示词」设计（待办，F8 首次引导因此暂缓）**」整条替换为：

```md
- ~~「职业 → 两组提示词」设计~~ **已放弃（2026-09-08）**：ASR 层按职业切词表是伪需求（内部专名表全体共享、内容数据驱动，与用户自报职业无关）；润色层用 last-used 默认场景覆盖，不再需要「职业」维度。F8 改为欢迎页。
```

- [ ] **Step 5: 通读 PRD 全文确认无「职业」残留表述**

Run: `grep -n "职业" docs/plans/2026-09-05-voicepilot-prd.md`
Expected: 除「跨境电商」（§2.1 语境，无「职业」二字）外，不应再有「职业」作为产品维度出现；如仍有 §4.0/§5.3 之外的「职业」残留，逐一改成中性表述或删除。

- [ ] **Step 6: Commit**

```bash
git add docs/plans/2026-09-05-voicepilot-prd.md
git commit -m "docs(prd): 移除职业维度，F8 改欢迎页、词表解绑、开放问题标记已放弃"
```

---

## Self-Review 记录

- **Spec 覆盖**：spec §1（欢迎页）→ Task 2/3；§2（last-used）→ Task 4；§3 代码清单 → Task 1-4 逐条对应；§5 PRD → Task 5；§6 测试 → Task 1 的 selftest + 各 Task 的 typecheck/手工验证。ASR 词表（spec「本期留空，无代码变更」）无对应代码任务，正确。
- **占位符**：无 TBD/TODO；所有代码步骤给出实际内容。
- **类型一致性**：`setMeta`/`getMeta` 来自 `store.js`，`closeOnboarding` 保留于桥与类型，`vp:polish/start` 的 `scene.name` 字段与现有 `Preset` 一致；无命名漂移。
