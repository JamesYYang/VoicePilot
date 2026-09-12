# 试用反馈快速三项 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复听写分段（按停顿分自然段）、润色模型换 `deepseek-v4-flash-0731`、全局快捷键可自定义（吸收 PRD 的 F7）。

**Architecture:** 三项互不依赖，可分头落地。分段判据从 `app/src/App.tsx` 里抽成独立可测模块（源无关：优先服务端时间戳，缺失时退化为本地接收时间差）；润色只改模型常量；快捷键从 `app/electron/main.js` 的硬编码改为读 store + 注销/重注册，设置界面（`app/src/studio/SettingsView.tsx`）新增录制控件。

**Tech Stack:** Electron 44（内置 Node 24）、React + TS（Vite）、`node:sqlite`（`node:sqlite` 的 `DatabaseSync`）、自建自测（无第三方框架）。

## Global Constraints

- 平台：Windows 与 macOS 同等对待，不得只改一个平台。
- 测试无第三方框架：
  - 主进程自测 `cd app && VP_<NAME>_SELFTEST=1 npx electron .`（不建窗口、跑完即退、退出码表达成败）
  - 渲染进程自测 `cd app && npm run build && VP_UI_SELFTEST=1 npx electron .`
    —— **必须先 build**：界面自测加载的是 `app/dist/renderer` 的构建产物（`app/src/main.tsx` 经 `app://` 协议加载，见 `app/electron/main.js` 的 `RENDERER_DIR`），不 build 就会跑到旧代码，断言静默对不上。
  - `cd app && npm run typecheck` 必须干净
- i18n 三语必须齐全：`app/shared/i18n/zh-CN.js`、`zh-TW.js`、`en-US.js`；**不得硬编码中文**。
- 默认快捷键：Windows `Ctrl+Shift+Space`，macOS `Alt+Space`（与 `app/electron/main.js:418` 现状一致）。
- 润色模型常量为 `deepseek-v4-flash-0731`（`app/electron/llm/polish.js:5`）。
- 分段语义 = 「按停顿分自然段」，自适应阈值：中位数 × 2.5，下限 1200ms，窗口 10（沿用 `App.tsx:34-36` 的既有取值）。判据不得只依赖单一服务端字段。
- 提交粒度：每个 Task 结束提交一次。

---

### Task 1: 加 ASR 原始事件诊断开关，确认新模型字段

新模型 `qwen-audio-3.0-asr-flash-streaming` 是否返回 `begin_time`/`end_time`/`sentence_id` 未经核实，本 Task 只加一个**默认关闭**的高频日志开关，供人工抓一帧真实事件。**不改任何业务行为。**

**Files:**
- Modify: `app/electron/asr/session.js`（`result-generated` 分支，约 153-167 行）

**Interfaces:**
- Consumes: 无
- Produces: 环境变量 `VP_ASR_DEBUG`（任意非空值开启）；不影响任何既有接口

- [ ] **Step 1: 加开关与限频日志**

在 `app/electron/asr/session.js` 顶部模块作用域（`const DEFAULT_TIMEOUTS = {` 之前）加：

```js
// 诊断开关：VP_ASR_DEBUG=1 时打印原始 sentence 对象。用于核实新模型是否返回
// begin_time/end_time/sentence_id —— 分段判据依赖它们是否存在。默认关闭，
// 且每会话最多打 20 条，避免长口述把终端刷爆。
const DEBUG_ASR = !!process.env.VP_ASR_DEBUG;
const DEBUG_LIMIT = 20;
let debugCount = 0;
```

在 `result-generated` 分支里、`const s = msg.payload?.output?.sentence ?? {};` 之后插入：

```js
        if (DEBUG_ASR && debugCount < DEBUG_LIMIT) {
          debugCount += 1;
          console.log(`[ASR原始 ${debugCount}] ${JSON.stringify(s)}`);
        }
```

- [ ] **Step 2: 回归状态机自测（确认没碰坏会话路径）**

Run: `cd app && VP_SM_SELFTEST=1 npx electron .`
Expected: 通过，退出码 0（只加了一行日志，行为不变）

- [ ] **Step 3: 抓一帧真实事件（不需要麦克风）**

`app/electron/selftest/asr.js` 会构造**真实 `AsrSession`** 回放 `spike/audio/01-dictation-16k.wav`，配上本 Task 的开关即可直接打印原始帧：

Run: `cd app && VP_ASR_DEBUG=1 VP_ASR_SELFTEST=1 npx electron .`
（需仓库根 `.env` 凭据；会真实调用百炼一次，费用可忽略。退出码可能因延迟预算不达标而非零，与本 Task 无关。）
Expected: 出现若干行 `[ASR原始 n] {...}`。

- [ ] **Step 4: 结论（2026-09-12 已实测，决定 Task 2 走哪条判据）**

实测结果（详见 `.superpowers/sdd/2026-09-12-feedback-quick-fixes/task-1-report.md` §8）：

- ✅ `begin_time` / `end_time` **存在**：`begin_time` 在所有文本帧上非 null；`end_time` 在**非定稿帧上为 null**，仅在 `sentence_end=true` 的帧上非 null。
- ✅ `sentence_id` **存在**（注意：长句内会长时间停在同一 id）。
- ✅ `sentence_end` **会**出现 `true`，但**很稀疏**：连续朗读素材 49.5s 内仅 4 次定稿（与既有已知限制「连续不停顿语音 ~15-20s 强制定稿一次」一致）。
- 结论：**Task 2 的服务端时间戳路径是活路径**；源无关模块保留「本地接收时间差」作为兜底即可。`end_time` 只在定稿帧读，与模块实现一致。

- [ ] **Step 5: Commit**

```bash
git add app/electron/asr/session.js
git commit -m "chore(asr): 加 VP_ASR_DEBUG 原始事件日志开关（默认关闭）"
```

---

### Task 2: 把分段判据抽成独立可测模块

**Files:**
- Create: `app/src/segment/segmenter.ts`
- Test: `app/src/uitest/run.tsx`（`runUiTest()` 汇总块之前追加断言区块）

> 注意：本 Task **不碰** `app/src/App.tsx`。本地 `median` / `breakThresholdMs` / `PARA_BREAK_*` 的删除与接入属于 Task 3 —— 在这里先删会让 App.tsx 立刻编译不过（它的分段逻辑还在用它们）。

**Interfaces:**
- Consumes: 无
- Produces:
  - `export interface PartialLike { sentenceEnd: boolean; beginTime: number | null; endTime: number | null; recvAtMs: number }`
  - `export const PARA_BREAK_MIN_MS = 1200`, `PARA_BREAK_MULT = 2.5`, `GAP_WINDOW = 10`
  - `export function median(xs: number[]): number`
  - `export function breakThresholdMs(gaps: number[]): number`
  - `export class ParagraphSegmenter { offer(e: PartialLike): { paraBreak: boolean; gap: number } | null; reset(): void }`

- [ ] **Step 1: 先写失败断言**

在 `app/src/uitest/run.tsx` 顶部 import 区加：

```tsx
import { ParagraphSegmenter, breakThresholdMs, median } from '../segment/segmenter';
```

在 `runUiTest()` 里、汇总块 `const failed = results.filter((r) => !r.ok);` **之前**追加（注意：不要追加到函数外，`check` 与 `results` 都在函数作用域内）：

```tsx
  // ---- 20. 分段判据（源无关）----
  check('median 偶数个取中间两数平均', median([1, 2, 3, 4]) === 2.5);
  check('median 空数组为 0', median([]) === 0);
  check('阈值下限 1200ms 生效', breakThresholdMs([10, 10, 10]) === 1200);

  {
    // 服务端时间戳路径。注意自适应阈值的基线效应：必须先积累几句短停顿，
    // 让中位数待在低位、阈值被 1200ms 下限兜住；否则单个大 gap 会把中位数
    // （连同阈值）一起抬高，反而不会分段 —— 这是既有设计，不是 bug。
    const seg = new ParagraphSegmenter();
    const final = (beginTime: number, endTime: number, recvAtMs: number) => ({
      sentenceEnd: true, beginTime, endTime, recvAtMs,
    });
    const mid = (beginTime: number | null, recvAtMs: number) => ({
      sentenceEnd: false, beginTime, endTime: null, recvAtMs,
    });
    check('首句不分段', seg.offer(final(0, 500, 1000))?.paraBreak === false);
    seg.offer(mid(600, 1100));
    check('短停顿 200ms 不分段', seg.offer(final(700, 1200, 1300))?.paraBreak === false);
    seg.offer(mid(1300, 1400));
    check('短停顿 200ms 仍不分段', seg.offer(final(1400, 1900, 1500))?.paraBreak === false);
    seg.offer(mid(3900, 2000));
    check('长停顿 2000ms 触发分段', seg.offer(final(3900, 4400, 2100))?.paraBreak === true);
  }

  {
    // 无服务端时间戳：退化用本地接收时间差（上一句定稿到达 → 下一句首个中间结果到达）
    const seg = new ParagraphSegmenter();
    const final = (recvAtMs: number) => ({
      sentenceEnd: true, beginTime: null, endTime: null, recvAtMs,
    });
    const mid = (recvAtMs: number) => ({
      sentenceEnd: false, beginTime: null, endTime: null, recvAtMs,
    });
    check('无时间戳：首句不分段', seg.offer(final(1500))?.paraBreak === false);
    seg.offer(mid(1700));
    check('无时间戳：本地 gap 200ms 不分段', seg.offer(final(2000))?.paraBreak === false);
    seg.offer(mid(2200));
    check('无时间戳：本地 gap 200ms 仍不分段', seg.offer(final(2500))?.paraBreak === false);
    seg.offer(mid(4500));
    check('无时间戳：本地 gap 2000ms 触发分段', seg.offer(final(5000))?.paraBreak === true);
  }

  {
    // reset 必须真的清空 gap 窗口。做法：先把窗口喂成大间隔（把中位数抬到 5000、
    // 阈值 12500），reset 后重喂短间隔再给一个 2000ms 间隔。
    // 若 reset 是空实现，历史大间隔会把中位数留在 2000（阈值 5000），
    // 那个 2000ms 间隔就触发不了分段 —— 断言失败。空实现能骗过的版本没有意义。
    const seg = new ParagraphSegmenter();
    const f = (beginTime: number, endTime: number, recvAtMs: number) => ({
      sentenceEnd: true, beginTime, endTime, recvAtMs,
    });
    seg.offer(f(0, 1000, 1));
    seg.offer(f(6000, 7000, 2));    // gap 5000
    seg.offer(f(12000, 13000, 3));  // gap 5000
    seg.offer(f(18000, 19000, 4));  // gap 5000 → gaps=[5000,5000,5000]

    seg.reset();

    seg.offer(f(0, 1000, 5));       // reset 后首句
    seg.offer(f(1200, 2200, 6));    // gap 200
    seg.offer(f(2400, 3400, 7));    // gap 200
    seg.offer(f(3600, 4600, 8));    // gap 200 → gaps=[200,200,200]
    const after = seg.offer(f(6600, 7600, 9)); // gap 2000 → 阈值 1200，应分段
    check('reset 真的清空了 gap 窗口', after?.paraBreak === true, JSON.stringify(after));
  }
```

- [ ] **Step 2: 运行，确认失败**

Run: `cd app && npm run build && VP_UI_SELFTEST=1 npx electron .`
Expected: 构建失败或断言失败（`../segment/segmenter` 不存在）→ 退出码非 0

- [ ] **Step 3: 实现模块**

Create `app/src/segment/segmenter.ts`:

```ts
/**
 * 分段判据：把「哪些定稿句该另起一段」从 App.tsx 里抽出来，做成可单测的纯逻辑。
 *
 * gap（句间停顿）的来源不固定：百炼的 sentence 对象在不同模型上带不带
 * begin_time/end_time 并不一致。所以两条路都支持：
 *   1. 服务端时间戳齐全 → cur.beginTime - prev.endTime
 *   2. 任一缺失 → 「本地接收时间差」：上一句定稿事件到达本地后，到下一句第一个
 *      中间结果到达本地之间的毫秒数。
 * 两者都是「停顿越长、gap 越大」的单调代理，配合自适应阈值够用。
 */

export interface PartialLike {
  sentenceEnd: boolean;
  beginTime: number | null;
  endTime: number | null;
  /** 本事件到达渲染进程的本地时间（epoch ms，始终有） */
  recvAtMs: number;
}

export const PARA_BREAK_MIN_MS = 1200;
export const PARA_BREAK_MULT = 2.5;
export const GAP_WINDOW = 10;

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function breakThresholdMs(gaps: number[]): number {
  return Math.max(median(gaps) * PARA_BREAK_MULT, PARA_BREAK_MIN_MS);
}

export class ParagraphSegmenter {
  #prevEndServer: number | null = null;
  #prevEndRecv: number | null = null;
  #curStartRecv: number | null = null;
  #awaitingStart = false;
  #gaps: number[] = [];

  /** 喂入每个 partial 事件；只有句尾定稿（sentenceEnd）返回非 null。 */
  offer(e: PartialLike): { paraBreak: boolean; gap: number } | null {
    if (this.#awaitingStart) {
      // 上一句刚定稿，这一条就是下一句的第一个事件 → 记下它的到达时间
      this.#curStartRecv = e.recvAtMs;
      this.#awaitingStart = false;
    }
    if (!e.sentenceEnd) return null;

    let gap = 0;
    if (e.beginTime != null && this.#prevEndServer != null) {
      gap = e.beginTime - this.#prevEndServer;
    } else if (this.#prevEndRecv != null && this.#curStartRecv != null) {
      gap = this.#curStartRecv - this.#prevEndRecv;
    }
    if (gap > 0) {
      this.#gaps.push(gap);
      if (this.#gaps.length > GAP_WINDOW) this.#gaps.shift();
    }
    const paraBreak = gap > 0 && gap >= breakThresholdMs(this.#gaps);

    this.#prevEndServer = e.endTime ?? null;
    this.#prevEndRecv = e.recvAtMs;
    this.#awaitingStart = true;
    this.#curStartRecv = null;
    return { paraBreak, gap };
  }

  reset(): void {
    this.#prevEndServer = null;
    this.#prevEndRecv = null;
    this.#curStartRecv = null;
    this.#awaitingStart = false;
    this.#gaps = [];
  }
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `cd app && npm run build && VP_UI_SELFTEST=1 npx electron .`
Expected: 全部通过，退出码 0

- [ ] **Step 5: Commit**

```bash
git add app/src/segment/segmenter.ts app/src/uitest/run.tsx
git commit -m "feat(segment): 抽出源无关的分段判据模块 + 单测"
```

---

### Task 3: App.tsx 接入新分段模块

**Files:**
- Modify: `app/src/App.tsx`（删除 34-47 行的常量与函数、138-139 行的 `gapsRef`、204-221 行的判据、268-289 行的复位）

**Interfaces:**
- Consumes: `ParagraphSegmenter`（Task 2）
- Produces: 无新导出；`Partial` 接口新增 `recvAtMs: number`

- [ ] **Step 1: 扩展 Partial 接口并换 import**

`app/src/App.tsx` 顶部加：

```tsx
import { ParagraphSegmenter } from './segment/segmenter';
```

把 `Partial` 接口（约 78-83 行）改为：

```tsx
interface Partial {
  text: string;
  sentenceEnd: boolean;
  beginTime: number | null;
  endTime: number | null;
  /** 事件到达渲染进程的本地时间（主进程在 WS 收到时打点） */
  recvAtMs: number;
}
```

- [ ] **Step 2: 删除旧判据，改用模块**

删除 `PARA_BREAK_MIN_MS` / `PARA_BREAK_MULT` / `GAP_WINDOW` / `median` / `breakThresholdMs`（34-47 行），以及 `const gapsRef = useRef<number[]>([]);`（139 行）与 `const lastEndRef = useRef(0);`（137 行，如无其它引用则一并删）。

在 `const historyIdRef = useRef<number | null>(null);` 之后加：

```tsx
  const segmenterRef = useRef(new ParagraphSegmenter());
```

把 `onPartial` 订阅（约 204-221 行）替换为：

```tsx
    const offPartial = vp.onPartial((p: Partial) => {
      if (p.sentenceEnd) {
        const r = segmenterRef.current.offer({
          sentenceEnd: true,
          beginTime: p.beginTime,
          endTime: p.endTime,
          recvAtMs: p.recvAtMs,
        });
        setCommitted((prev) => [...prev, { text: p.text, paraBreak: r?.paraBreak === true }]);
        setDraft('');
      } else {
        segmenterRef.current.offer({
          sentenceEnd: false,
          beginTime: p.beginTime,
          endTime: p.endTime,
          recvAtMs: p.recvAtMs,
        });
        setDraft(p.text);
      }
    });
```

在 warming 复位块（约 268-289 行）里，把 `gapsRef.current = [];` 与 `lastEndRef.current = 0;` 换成：

```tsx
      segmenterRef.current.reset();
```

- [ ] **Step 3: 类型检查**

Run: `cd app && npm run typecheck`
Expected: 干净通过（无 `lastEndRef`/`gapsRef` 未使用报错）

- [ ] **Step 4: 跑界面自测**

Run: `cd app && npm run build && VP_UI_SELFTEST=1 npx electron .`
Expected: 全部通过，退出码 0（含既有分段断言 `第二件是识别\n第三件是润色`）

- [ ] **Step 5: 人工确认分段（需要麦克风）**

Run: `cd app && npm run start`
操作：连续说 3 句，句间停顿 2-3 秒。
Expected: 悬浮条出现多段（换行分隔），而非一坨。若仍不分段，调 `app/src/segment/segmenter.ts` 的 `PARA_BREAK_MIN_MS`（先降到 800）再试，并把最终值记录在此：

```
最终 PARA_BREAK_MIN_MS = ____
```

- [ ] **Step 6: Commit**

```bash
git add app/src/App.tsx
git commit -m "fix(segment): 悬浮条接入新分段判据，改用源无关 gap"
```

---

### Task 4: 润色模型换 flash

**Files:**
- Modify: `app/electron/llm/polish.js:5`
- Modify: `docs/plans/2026-09-05-voicepilot-prd.md`（§5 模型清单，若列了润色模型名）

**Interfaces:**
- Consumes: 无
- Produces: 无（仅换常量值）

- [ ] **Step 1: 换模型常量**

`app/electron/llm/polish.js:5`：

```js
const MODEL = 'deepseek-v4-flash-0731';
```

- [ ] **Step 2: 回归润色自测**

Run: `cd app && VP_POLISH_SELFTEST=1 npx electron .`
Expected: 通过，退出码 0。若因模型名不被接受而失败，记录 HTTP 错误原文并停下找设计者确认模型 ID：

```
（如失败，在此粘贴错误）
```

- [ ] **Step 3: 人工对比一次输出质量与耗时**

Run: `cd app && npm run start`
操作：录一段话 → 点「润色」，记录观感与耗时（与 pro 对比）。
Expected: 输出可用；耗时明显更短。

- [ ] **Step 4: Commit**

```bash
git add app/electron/llm/polish.js docs/plans/2026-09-05-voicepilot-prd.md
git commit -m "feat(polish): 润色模型换成 deepseek-v4-flash-0731（速度优先）"
```

---

### Task 5: store 增加快捷键读写 + 主进程自测

**Files:**
- Modify: `app/electron/store.js`（meta 区，复用 `getMeta`/`setMeta` 不新增表）
- Test: `app/electron/selftest/store.js`

**Interfaces:**
- Consumes: `getMeta` / `setMeta`（`app/electron/store.js:222-232`）
- Produces:
  - `export function getShortcut(): string | null` —— 返回用户自定义的 accelerator，未设置返回 `null`
  - `export function setShortcut(accel: string): void`
  - meta 键名固定为 `shortcut`

- [ ] **Step 1: 先写失败断言**

⚠️ `app/electron/selftest/store.js` **不使用** `check()` 助手（那是 `selftest/machine.js` 的模式），而是把一串布尔量 `okXxx` 汇总进末尾的 `const ok = ...`。照它自己的既有模式加，别引入 `check`。

在该文件顶部 import 列表（`migrateDefaultScene` 之后）加入 `getShortcut, setShortcut`。

在末尾 `const ok = okSeed && okWrite && ...` 这一行**之前**插入：

```js
  // 快捷键读写：未设置返回 null；设置后可读回；覆盖写生效
  const okShortcutDefault = getShortcut() === null;
  setShortcut('CommandOrControl+Alt+Space');
  const okShortcutSet = getShortcut() === 'CommandOrControl+Alt+Space';
  setShortcut('CommandOrControl+Shift+K');
  const okShortcutOverwrite = getShortcut() === 'CommandOrControl+Shift+K';
```

然后把布尔量接进汇总：`const ok = ... && okShortcutDefault && okShortcutSet && okShortcutOverwrite;`，并在下面那行 `console.log(\`[自测] ...\`)` 的尾部追加一段 `` 快捷键=${okShortcutDefault && okShortcutSet && okShortcutOverwrite} ``。

- [ ] **Step 2: 运行，确认失败**

Run: `cd app && VP_STORE_SELFTEST=1 npx electron .`
Expected: 退出码非 0（导入未导出的 `getShortcut` 会得到 `undefined`，调用即抛错；`main.js` 的 selftest 分支接住后 `requestQuit(1)`）

- [ ] **Step 3: 实现**

在 `app/electron/store.js` 的「元数据」区末尾追加：

```js
// ---------------------------------------------------------------- 快捷键

const SHORTCUT_KEY = 'shortcut';

/** 用户自定义的全局快捷键（Electron accelerator）。未设置返回 null，调用方用默认值。 */
export function getShortcut() {
  const v = getMeta(SHORTCUT_KEY);
  return v && v.trim() ? v : null;
}

export function setShortcut(accel) {
  setMeta(SHORTCUT_KEY, String(accel));
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `cd app && VP_STORE_SELFTEST=1 npx electron .`
Expected: 通过，退出码 0

- [ ] **Step 5: Commit**

```bash
git add app/electron/store.js app/electron/selftest/store.js
git commit -m "feat(store): 快捷键配置读写 + 自测"
```

---

### Task 6: 主进程快捷键可配（注册 / 注销 / 冲突）

**Files:**
- Modify: `app/electron/main.js`（`registerShortcuts` 约 415-432 行、`rebuildTray` 之后新增 `applyShortcut`、`will-quit` 约 514-516 行）
- Modify: `app/electron/ipc.js`（新增 `vp:shortcut/get` / `vp:shortcut/set`）
- Modify: `app/electron/preload.cjs`（暴露 `getShortcut` / `setShortcut`）
- Modify: `app/src/global.d.ts`（补类型）

**Interfaces:**
- Consumes: `getShortcut` / `setShortcut`（Task 5）
- Produces:
  - 主进程内部 `function applyShortcut(accel: string): boolean` —— 注销旧的、注册新的；成功返回 true
  - IPC `vp:shortcut/get` → `{ accel: string; isDefault: boolean }`
  - IPC `vp:shortcut/set` → `{ ok: boolean; accel: string }`（冲突时 `ok:false` 且不改动 store，保留旧键）
  - bridge: `getShortcut()`, `setShortcut(accel)`

- [ ] **Step 1: 实现主进程 applyShortcut 并替换 registerShortcuts**

在 `app/electron/main.js` 顶部 import 区加入：

```js
import { getShortcut, setShortcut } from './store.js';
```

（若已有 `import { getMeta } from './store.js';` 则合并成一行。）

把 `registerShortcuts(machine)`（415-432 行）整体替换为：

```js
/** 平台默认快捷键。Windows 不能用 Alt+Space（系统菜单）或 Win+Space（输入法切换）。 */
function defaultAccel() {
  return process.platform === 'darwin' ? 'Alt+Space' : 'Ctrl+Shift+Space';
}

/** 当前生效的快捷键（用户自定义优先）。 */
function currentAccel() {
  return getShortcut() ?? defaultAccel();
}

let boundAccel = null;

/**
 * 注销旧的、注册新的。返回是否成功。
 * 失败（被别的程序占用）时不改 store —— 保持「当前生效键」与「已存键」一致。
 */
function applyShortcut(machine, accel) {
  if (boundAccel) globalShortcut.unregister(boundAccel);
  const ok = globalShortcut.register(accel, () => {
    // 直接驱动状态机，不再经渲染进程转发（状态只有一个源头）
    void machine.toggle();
  });
  if (ok) {
    boundAccel = accel;
    console.log(`[快捷键] ${accel} 已注册`);
  } else {
    // 注册失败：回滚到上一个可用键，避免出现「一个键都没有」
    console.error(`[快捷键] ${accel} 注册失败：可能已被其他程序占用`);
    if (boundAccel) {
      globalShortcut.register(boundAccel, () => void machine.toggle());
    }
  }
  return ok;
}
```

在 `app.whenReady()` 里把 `registerShortcuts(machine);`（484 行）改为：

```js
  applyShortcut(machine, currentAccel());
```

在 `app.on('will-quit', ...)`（514-516 行）里，把 `globalShortcut.unregisterAll();` 保留即可（无需改）。

- [ ] **Step 2: 加 IPC**

在 `app/electron/ipc.js` 的通用区（`vp:quit` 之后）加：

```js
  // ---------------------------------------------------------------- 快捷键（F7）

  /** 读当前快捷键。isDefault 表示用户没自定义过。 */
  ipcMain.handle('vp:shortcut/get', () => {
    const custom = getShortcut();
    return { accel: custom ?? defaultAccel(), isDefault: custom == null };
  });

  /**
   * 设置快捷键。成功则落库并重注册；失败（冲突）返回 ok:false 且不改动。
   * 需要 main.js 传进来的 applyShortcut / defaultAccel。
   */
  ipcMain.handle('vp:shortcut/set', (_e, accel) => {
    const next = String(accel ?? '').trim();
    if (!next) return { ok: false, accel: currentAccel() };
    const ok = applyShortcut(machine, next);
    if (ok) setShortcut(next);
    return { ok, accel: currentAccel() };
  });
```

`registerIpc` 的入参解构（`app/electron/ipc.js:28`）加入 `applyShortcut, currentAccel, defaultAccel`，并在 import 行加入 `getShortcut, setShortcut`：

```js
import { getShortcut, setShortcut } from './store.js';
```

（若已有 `./store.js` 的 import 行，合并进去。）

在 `app/electron/main.js:443` 的 `registerIpc({...})` 调用里补上这三个回调。

- [ ] **Step 3: 暴露到 bridge 与类型**

`app/electron/preload.cjs`（「权限（F12）」之前）加：

```js
  // ---------------------------------------------------------------- 快捷键（F7）

  /** 读当前快捷键 { accel, isDefault }。 */
  getShortcut() {
    return ipcRenderer.invoke('vp:shortcut/get');
  },

  /** 设置快捷键。冲突时返回 { ok:false } 且不生效。 */
  setShortcut(accel) {
    return ipcRenderer.invoke('vp:shortcut/set', accel);
  },
```

`app/src/global.d.ts` 的 `voicepilot` 接口加：

```ts
    /** 读当前全局快捷键。isDefault 表示未自定义。 */
    getShortcut(): Promise<{ accel: string; isDefault: boolean }>;
    /** 设置全局快捷键。冲突时 ok:false 且不生效。 */
    setShortcut(accel: string): Promise<{ ok: boolean; accel: string }>;
```

- [ ] **Step 4: 类型检查 + 既有自测回归**

Run: `cd app && npm run typecheck`
Expected: 干净通过

Run: `cd app && VP_SM_SELFTEST=1 npx electron .`
Expected: 通过，退出码 0（状态机未受影响）

- [ ] **Step 5: Commit**

```bash
git add app/electron/main.js app/electron/ipc.js app/electron/preload.cjs app/src/global.d.ts
git commit -m "feat(shortcut): 全局快捷键可配（注册/注销/冲突回滚）+ IPC"
```

---

### Task 7: 设置页加快捷键录制控件 + 三语文案

**Files:**
- Modify: `app/src/studio/SettingsView.tsx`
- Modify: `app/shared/i18n/zh-CN.js`、`zh-TW.js`、`en-US.js`
- Test: `app/src/uitest/run.tsx`

**Interfaces:**
- Consumes: bridge `getShortcut()` / `setShortcut()`（Task 6）
- Produces: 设置页新增区块，`data-testid="settings-shortcut"`（当前键文本）与 `data-testid="settings-shortcut-record"`（录制按钮）

- [ ] **Step 1: 加三语文案**

`app/shared/i18n/zh-CN.js` 追加：

```js
  'settings.shortcut': '快捷键',
  'settings.shortcut.record': '点击录制',
  'settings.shortcut.recording': '请按下新的组合键…',
  'settings.shortcut.reset': '恢复默认',
  'settings.shortcut.conflict': '该快捷键已被占用，请换一个',
  'settings.shortcut.hint': '按下组合键即可修改全局听写快捷键',
```

`app/shared/i18n/zh-TW.js` 追加：

```js
  'settings.shortcut': '快捷鍵',
  'settings.shortcut.record': '點擊錄製',
  'settings.shortcut.recording': '請按下新的組合鍵…',
  'settings.shortcut.reset': '恢復預設',
  'settings.shortcut.conflict': '該快捷鍵已被佔用，請換一個',
  'settings.shortcut.hint': '按下組合鍵即可修改全域聽寫快捷鍵',
```

`app/shared/i18n/en-US.js` 追加：

```js
  'settings.shortcut': 'Shortcut',
  'settings.shortcut.record': 'Record',
  'settings.shortcut.recording': 'Press a new key combination…',
  'settings.shortcut.reset': 'Reset to default',
  'settings.shortcut.conflict': 'That shortcut is taken. Try another.',
  'settings.shortcut.hint': 'Press a key combination to change the global dictation shortcut',
```

- [ ] **Step 2: 写失败断言**

在 `app/src/uitest/run.tsx` 顶部 import 区加：

```tsx
import SettingsView from '../studio/SettingsView';
```

在 `runUiTest()` 的汇总块 `const failed = results.filter((r) => !r.ok);` **之前**追加（`SettingsView` 独立成一棵树，单起容器；假 bridge 沿用 Studio 那段同款模式）：

```tsx
  // ---- 21. 设置页快捷键 ----
  const settingsContainer = document.createElement('div');
  document.body.appendChild(settingsContainer);

  const shortcutSet: { payloads: string[] } = { payloads: [] };
  const settingsBridge = {
    ...real,
    // contextBridge 属性不可枚举，展开复制不到，用到的必须显式声明
    getLanguage: () => Promise.resolve({ locale: 'zh-CN' as const }),
    onLanguageChanged: () => () => {},
    setLanguage: () => Promise.resolve({ ok: true, locale: 'zh-CN' as const }),
    getPermissionStatus: () => Promise.resolve({ accessibility: null }),
    openAccessibilitySettings: () => Promise.resolve(false),
    getShortcut: () => Promise.resolve({ accel: 'Ctrl+Shift+Space', isDefault: true }),
    setShortcut: (a: string) => {
      shortcutSet.payloads.push(a);
      return Promise.resolve({ ok: true, accel: a });
    },
  };

  createRoot(settingsContainer).render(<SettingsView bridge={settingsBridge} />);
  const accelEl = () => settingsContainer.querySelector('[data-testid="settings-shortcut"]')?.textContent;
  const shownInitial = await waitFor(() => accelEl() === 'Ctrl+Shift+Space');
  check('设置页渲染当前快捷键', shownInitial, JSON.stringify(accelEl()));

  const recBtn = settingsContainer.querySelector<HTMLButtonElement>('[data-testid="settings-shortcut-record"]');
  check('录制按钮存在', recBtn != null);

  recBtn?.click();
  await flush();
  // 录制态：派发一个带修饰键的 keydown（捕获阶段监听，派发到 window 即可命中）
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, altKey: true }));
  await flush();
  check('录制后调用 setShortcut 且载荷正确', shortcutSet.payloads[0] === 'Ctrl+Alt+Y',
    JSON.stringify(shortcutSet.payloads));
  const shownUpdated = await waitFor(() => accelEl() === 'Ctrl+Alt+Y');
  check('成功后界面显示新快捷键', shownUpdated, JSON.stringify(accelEl()));
```

- [ ] **Step 3: 运行，确认失败**

Run: `cd app && npm run build && VP_UI_SELFTEST=1 npx electron .`
Expected: FAIL（找不到 `settings-shortcut-record`）→ 退出码非 0

- [ ] **Step 4: 实现控件**

在 `app/src/studio/SettingsView.tsx` 里，`语言` 区块之后、`权限` 区块之前插入：

```tsx
      <h2 style={{ ...styles.h2, marginTop: 16 }}>{t('settings.shortcut')}</h2>
      <ShortcutSetting vp={vp} />
```

在文件底部（`const styles` 之前）加组件：

```tsx
/**
 * 快捷键录制。点击后进入录制态，捕获下一个带修饰键的组合键。
 * 冲突（主进程注册失败）时显示提示且**不更新**界面上的当前键。
 */
function ShortcutSetting({ vp }: { vp: Window['voicepilot'] }) {
  const t = useT();
  const [accel, setAccel] = useState('');
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void vp.getShortcut().then((r) => { if (alive) setAccel(r.accel); }).catch(() => {});
    return () => { alive = false; };
  }, [vp]);

  // 录制：只在 recording 时监听 keydown；忽略纯修饰键本身
  useEffect(() => {
    if (!recording) return;
    const onKey = async (e: KeyboardEvent) => {
      e.preventDefault();
      const mods: string[] = [];
      if (e.ctrlKey) mods.push('Ctrl');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');
      if (e.metaKey) mods.push('Super');
      const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      const isModifierOnly = ['Control', 'Alt', 'Shift', 'Meta'].includes(e.key);
      if (isModifierOnly || mods.length === 0) return;
      const next = [...mods, key].join('+');
      setRecording(false);
      const r = await vp.setShortcut(next).catch(() => ({ ok: false, accel }));
      if (r.ok) { setAccel(r.accel); setError(''); }
      else { setError(t('settings.shortcut.conflict')); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, vp, t, accel]);

  return (
    <div style={styles.block}>
      <div style={styles.statusRow}>
        <span data-testid="settings-shortcut" style={styles.label}>
          {recording ? t('settings.shortcut.recording') : accel}
        </span>
        <button
          data-testid="settings-shortcut-record"
          style={styles.button}
          onClick={() => { setError(''); setRecording(true); }}
        >
          {t('settings.shortcut.record')}
        </button>
      </div>
      {error && <span style={{ color: '#dc2626' }}>{error}</span>}
      <span style={styles.plain}>{t('settings.shortcut.hint')}</span>
    </div>
  );
}
```

- [ ] **Step 5: 运行，确认通过**

Run: `cd app && npm run build && VP_UI_SELFTEST=1 npx electron .`
Expected: 全部通过，退出码 0

Run: `cd app && npm run typecheck`
Expected: 干净通过

- [ ] **Step 6: 人工验证改键（Win 与 macOS 各一次）**

Run: `cd app && npm run start`
操作：打开设置 → 点录制 → 按 `Ctrl+Alt+Y`（Mac 上 `Alt+Cmd+Y`）→ 关闭设置 → 按新键。
Expected: 悬浮条被唤起；旧的默认键不再触发。故意录一个被系统占用的键（如 Win 的 `Ctrl+Alt+Del` 无法录制，可试 `Ctrl+Shift+Esc`）应看到冲突提示。

- [ ] **Step 7: Commit**

```bash
git add app/src/studio/SettingsView.tsx app/shared/i18n/zh-CN.js app/shared/i18n/zh-TW.js app/shared/i18n/en-US.js app/src/uitest/run.tsx
git commit -m "feat(settings): 快捷键录制控件 + 三语文案 + 界面自测"
```

---

## 收尾验证

- [ ] `cd app && npm run typecheck`
- [ ] `cd app && VP_STORE_SELFTEST=1 npx electron .`
- [ ] `cd app && npm run build && VP_UI_SELFTEST=1 npx electron .`
- [ ] `cd app && VP_SM_SELFTEST=1 npx electron .`
- [ ] `cd app && VP_POLISH_SELFTEST=1 npx electron .`
- [ ] 真机 Win + macOS 各跑一次：说 3 句看分段、润色一次、改一次快捷键。

## 与后续计划的关系

本计划只覆盖反馈第 3/4/5 条。**反馈第 1/2 条（悬浮条内闭环 + 采纳写回目标应用）单独成篇**（拟名 `2026-09-12-bar-closed-loop-adopt.md`，尚未撰写）：它依赖一个尚未选定的原生依赖（取前台窗口 / 置前 / 发按键），需先做依赖验证，故不与本计划合并。
