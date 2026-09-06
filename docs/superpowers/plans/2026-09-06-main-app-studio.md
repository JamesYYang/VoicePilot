# 主应用（Studio）骨架 + 润色工作区 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户从悬浮条点「润色」打开亮色的主应用窗口，在可编辑编辑器里看到本次口述原文，选场景/语气后流式润色，并排查看，显式采用后复制。

**Architecture:** 主进程新建一个可聚焦窗口（`#studio` 路由）。润色 LLM 调用开在**主进程**（复用 `loadCredentials()`，与 ASR 同 Key），走百炼 OpenAI 兼容端点流式；渲染进程只负责 UI，收 delta 逐字上屏。与 M2 的 ASR 架构同构。

**Tech Stack:** Electron 44 + React 19 + Vite + TS strict。百炼文本模型 `deepseek-v4-pro-0813`（已验证，见 `spike/llm.js`）。

**Spec:** `docs/superpowers/specs/2026-09-06-main-app-design.md`

## Global Constraints

- API Key 只在主进程，渲染进程永不接触（PRD §5.8）。润色 LLM 客户端开在主进程。
- 润色走流式：SSE，`choices[0].delta.content` 逐块；**忽略 `reasoning_content`**（思维链，不上屏）。
- 端点：`https://{workspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions`；头：`Authorization: Bearer <key>` + `X-DashScope-WorkSpace: <ws>`。
- 场景 4 类：邮件 / 即时通讯 / 文档 / 社媒；语气 4 类：正式 / 口语 / 简洁 / 热情。
- 并排显示，显式「采用」才替换原文（PRD §4.4）。
- 主应用是**亮色**；本期不换悬浮条颜色（换色放下一个计划）。
- 自测复用 M2 的两种模式：主进程自测（`VP_*_SELFTEST=1 npx electron .`，跑完退出）+ 界面自测（隐藏窗口 + 假 bridge）。

---

### Task 1: 场景/语气常量与 prompt 映射（主进程，纯 JS）

**Files:**
- Create: `app/electron/llm/prompt.js`

**Interfaces:**
- Produces:
  - `export const SCENES = ['邮件', '即时通讯', '文档', '社媒']`
  - `export const TONES = ['正式', '口语', '简洁', '热情']`
  - `export function buildPolishMessages(text, scene, tone) → { system, user }`

**为什么放主进程的 `.js`**：主进程是纯 ESM 不编译 TS，渲染进程也不该依赖主进程模块。场景/语气列表是唯一的公共数据，放主进程，渲染进程经 `vp:studio/sync` 拉取（Task 4），避免两处硬编码漂移。

- [ ] **Step 1: 写文件**

`app/electron/llm/prompt.js`：

```js
export const SCENES = ['邮件', '即时通讯', '文档', '社媒'];
export const TONES = ['正式', '口语', '简洁', '热情'];

/** 构造润色请求的 system + user 两条消息。 */
export function buildPolishMessages(text, scene, tone) {
  return {
    system:
      `你是文字润色助手。根据场景和语气改写用户文本，` +
      `只输出改写后的文本，不要解释、不要加引号、不要多余内容。\n\n` +
      `场景：${scene}\n语气：${tone}`,
    user: text,
  };
}
```

- [ ] **Step 2: 语法检查**

Run: `cd app && node --check electron/llm/prompt.js`
Expected: 无输出（语法通过）

- [ ] **Step 3: Commit**

```bash
git add app/electron/llm/prompt.js
git commit -m "feat(studio): 场景/语气常量与润色 prompt 映射"
```

---

### Task 2: 润色 LLM 流式客户端（主进程）+ 离线自测

**Files:**
- Create: `app/electron/llm/polish.js`
- Create: `app/electron/selftest/polish.js`
- Modify: `app/electron/main.js`（selftest 分支加 `VP_POLISH_SELFTEST`）

**Interfaces:**
- Consumes: `loadCredentials()`（`../asr/config.js`，返回 `{apiKey, workspaceId}`）、`buildPolishMessages`（Task 1）
- Produces: `streamPolish({ text, scene, tone, onDelta, onDone, onError }) → Promise<void>`（失败时抛错，onError 用于运行中错误）

- [ ] **Step 1: 写客户端**

`app/electron/llm/polish.js`：

```js
import { loadCredentials } from '../asr/config.js';
import { buildPolishMessages } from './prompt.js';

const MODEL = 'deepseek-v4-pro-0813';

/**
 * 流式润色。delta 经 onDelta 逐块交付。
 * 只取 content，reasoning_content（思维链）一律丢弃。
 */
export async function streamPolish({ text, scene, tone, onDelta, onDone, onError }) {
  const { apiKey, workspaceId } = loadCredentials();
  const { system, user } = buildPolishMessages(text, scene, tone);

  const res = await fetch(
    `https://${workspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-DashScope-WorkSpace': workspaceId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        stream: true,
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`润色请求失败 HTTP ${res.status} ${body.slice(0, 200)}`);
    onError(err);
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;

      let j;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = j.choices?.[0]?.delta?.content ?? '';
      if (delta) onDelta(delta);
    }
  }

  onDone();
}
```

- [ ] **Step 2: 写离线自测**

`app/electron/selftest/polish.js`：

```js
import { streamPolish } from '../llm/polish.js';

export async function runPolishSelftest() {
  console.log('[自测] 润色 LLM 流式');
  let full = '';
  let chunks = 0;
  let err = null;

  try {
    await streamPolish({
      text: '那个功能我们下周上线，你先看看有没有问题。',
      scene: '邮件',
      tone: '正式',
      onDelta: (d) => { full += d; chunks += 1; },
      onDone: () => {},
      onError: (e) => { err = e; },
    });
  } catch (e) {
    err = e;
  }

  // 多块才证明真的在流式；有内容证明模型可用
  const ok = !err && full.length > 0 && chunks > 1;
  console.log(`[自测] ${ok ? '通过' : '失败'} 块数=${chunks} 结果="${full}"`);
  if (err) console.error(`[自测] 错误：${err.message}`);
  return { ok, chunks, text: full };
}
```

- [ ] **Step 3: 接线 main.js 并跑**

`app/electron/main.js` 的 selftest 选择分支改为：

```js
const selftest = process.env.VP_ASR_SELFTEST
  ? './selftest/asr.js'
  : process.env.VP_SM_SELFTEST
    ? './selftest/machine.js'
    : process.env.VP_POLISH_SELFTEST
      ? './selftest/polish.js'
      : null;
```

并在 run 选择处加 `mod.runPolishSelftest`（`runAsrSelftest ?? runMachineSelftest ?? runPolishSelftest`）。

Run: `cd app && VP_POLISH_SELFTEST=1 timeout 60 npx electron .`
Expected: 退出码 0，打印「通过」，块数 > 1

- [ ] **Step 4: Commit**

```bash
git add app/electron/llm/polish.js app/electron/selftest/polish.js app/electron/main.js
git commit -m "feat(studio): 润色 LLM 流式客户端 + 离线自测"
```

---

### Task 3: studio 窗口 + #studio 路由 + 左侧导航骨架

**Files:**
- Create: `app/electron/studio.js`
- Create: `app/src/studio/Studio.tsx`
- Modify: `app/electron/main.js`（import + 托盘菜单项）
- Modify: `app/src/main.tsx`（#studio 路由）

**Interfaces:**
- Consumes: `attachDevLogging(win)`（main.js 现有）
- Produces: `createStudioWindow({ attachDevLogging }) → BrowserWindow`；模块级 `getStudioWindow()`

- [ ] **Step 1: 写窗口模块**

`app/electron/studio.js`：

```js
import { BrowserWindow } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
let studioWin = null;

export function createStudioWindow({ attachDevLogging }) {
  if (studioWin && !studioWin.isDestroyed()) {
    studioWin.focus();
    return studioWin;
  }

  studioWin = new BrowserWindow({
    width: 960,
    height: 700,
    minWidth: 720,
    minHeight: 480,
    title: 'VoicePilot 主应用',
    backgroundColor: '#ffffff', // 亮色（spec §2）
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  attachDevLogging(studioWin);
  studioWin.loadURL('app://voicepilot/index.html#studio');
  studioWin.on('closed', () => {
    studioWin = null;
  });
  return studioWin;
}

export function getStudioWindow() {
  return studioWin && !studioWin.isDestroyed() ? studioWin : null;
}
```

- [ ] **Step 2: 接线 main.js**

`main.js`：顶部 `import { createStudioWindow } from './studio.js';`；托盘菜单 `显示悬浮条` 之前加：

```js
{ label: '打开主应用', click: () => createStudioWindow({ attachDevLogging }) },
```

- [ ] **Step 3: #studio 路由**

`app/src/main.tsx` 的 `boot()` 里，在 `#diag` 判断后加：

```tsx
if (route === 'studio') {
  const { default: Studio } = await import('./studio/Studio');
  createRoot(container).render(<Studio />);
  return;
}
```

- [ ] **Step 4: Studio 骨架**

`app/src/studio/Studio.tsx`：左侧 48px 图标栏（三个按钮：润色/历史/设置，历史与设置点击显示「待实现」占位），右侧内容区。默认渲染 `<PolishView />`（Task 4 实现，先渲染占位 `<div>润色工作区</div>`）。亮色样式（`background: '#fff'`、深色文字）。

- [ ] **Step 5: 手动烟测 + Commit**

Run: `cd app && npm run build && timeout 15 npx electron .`，从托盘打开主应用
Expected: 亮色窗口，左侧三个图标，历史/设置显示占位

```bash
git add app/electron/studio.js app/src/studio/Studio.tsx app/electron/main.js app/src/main.tsx
git commit -m "feat(studio): 主应用窗口骨架 + 左侧导航"
```

---

### Task 4: 润色工作区 UI（编辑器 + 场景/语气 + 润色按钮）

**Files:**
- Create: `app/src/studio/PolishView.tsx`
- Modify: `app/electron/ipc.js`（`vp:studio/open`、`vp:studio/sync`）
- Modify: `app/electron/preload.cjs`（`openStudio`、`syncStudio`）
- Modify: `app/src/global.d.ts`（类型）

**Interfaces:**
- Consumes: `createStudioWindow`（Task 3）、`SCENES/TONES`（Task 1，经 `vp:studio/sync` 下发）
- Produces: `vp:studio/sync` → `{ text: string, scenes: string[], tones: string[] }`；`vp:polish/start`（invoke，`{ text, scene, tone }`，本任务 stub，Task 5 实现）

- [ ] **Step 1: IPC handler**

`app/electron/ipc.js`：

```js
import { createStudioWindow } from './studio.js';
import { SCENES, TONES } from './llm/prompt.js';

let pendingStudioText = '';

ipcMain.handle('vp:studio/open', (_e, text) => {
  pendingStudioText = String(text ?? '');
  createStudioWindow({ attachDevLogging: (win) => { /* 复用 main 的 attachDevLogging */ } });
  return true;
});

ipcMain.handle('vp:studio/sync', () => ({
  text: pendingStudioText,
  scenes: SCENES,
  tones: TONES,
}));
```

（`attachDevLogging` 目前在 main.js 里、未导出。**改法**：把它移到 `app/electron/devlog.js` 导出，main.js 和 ipc.js 都 import——或者 registerIpc 已接收 `getBar`，同样加一个 `attachDevLogging` 入参。选后者：`registerIpc({ getBar, requestQuit, attachDevLogging })`。）

- [ ] **Step 2: preload + 类型**

`preload.cjs` 加：

```js
openStudio(text) { return ipcRenderer.invoke('vp:studio/open', text); },
syncStudio() { return ipcRenderer.invoke('vp:studio/sync'); },
```

`global.d.ts` 加：

```ts
openStudio(text: string): Promise<boolean>;
syncStudio(): Promise<{ text: string; scenes: string[]; tones: string[] }>;
```

- [ ] **Step 3: PolishView**

`PolishView.tsx`：挂载时 `syncStudio()` 拉 `{text, scenes, tones}`；顶部工具条：场景下拉 + 语气下拉 + 「润色」按钮；可编辑 textarea（初值 = text）；底部「复制」「关闭」。点「润色」调 `vp.startPolish({text, scene, tone})`（本任务 stub 一个空 handler）。

- [ ] **Step 4: 界面自测**

`app/src/uitest/run.tsx` 追加：假 bridge 注入 `syncStudio` 返回 `{text:'测试原文', scenes:['邮件'], tones:['正式']}`，渲染 `<Studio>`，断言 textarea 值为「测试原文」、下拉存在、点润色调用了 `startPolish`。

- [ ] **Step 5: Commit**

```bash
git add app/src/studio/PolishView.tsx app/electron/ipc.js app/electron/preload.cjs app/src/global.d.ts app/src/uitest/run.tsx
git commit -m "feat(studio): 润色工作区 UI（编辑器 + 场景/语气）"
```

---

### Task 5: 并排流式润色（main 流式 → renderer 增量）

**Files:**
- Modify: `app/electron/ipc.js`（`vp:polish/start` 真实现）
- Modify: `app/electron/preload.cjs`（`startPolish`、`onPolishDelta`、`onPolishDone`、`onPolishError`）
- Modify: `app/src/studio/PolishView.tsx`（并排 + 增量渲染）
- Modify: `app/src/global.d.ts`

**Interfaces:**
- Consumes: `streamPolish`（Task 2）、`getStudioWindow`（Task 3）
- Produces: main→renderer 事件：`vp:polish/delta` `{text}`、`vp:polish/done` `{}`、`vp:polish/error` `{message}`

- [ ] **Step 1: main 侧 handler**

`ipc.js`：

```js
ipcMain.handle('vp:polish/start', async (_e, { text, scene, tone }) => {
  const win = getStudioWindow();
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

- [ ] **Step 2: preload + 类型**

`preload.cjs`：`startPolish(payload)`（invoke）、`onPolishDelta/onPolishDone/onPolishError`（subscribe）。`global.d.ts` 同步。

- [ ] **Step 3: renderer 增量渲染**

`PolishView` 加 `output` state 与 `polishing` state：点「润色」→ `startPolish` → `onPolishDelta` 追加 → `onPolishDone` 收尾 → `onPolishError` 显示错误。下方并排：左原文 textarea（可编辑）、右 output（`whiteSpace: pre-wrap`）。`polishing` 期间「润色」按钮禁用。

- [ ] **Step 4: 手动烟测**

Run: `cd app && npm run build && npm start`，真机：快捷键 → 说话 → 停止 → 点润色 → 逐字上屏
Expected: 润色结果流式出现，且**没有**思维链文本（reasoning_content 被丢弃）

- [ ] **Step 5: Commit**

```bash
git add app/electron/ipc.js app/electron/preload.cjs app/src/studio/PolishView.tsx app/src/global.d.ts
git commit -m "feat(studio): 并排流式润色"
```

---

### Task 6: 采用/复制/关闭 + 悬浮条「润色」入口

**Files:**
- Modify: `app/src/studio/PolishView.tsx`（采用/复制/关闭）
- Modify: `app/src/App.tsx`（reviewing 态加「润色」按钮）
- Modify: `app/electron/ipc.js`（`vp:studio/close`）
- Modify: `app/electron/preload.cjs` + `app/src/global.d.ts`

**Interfaces:**
- Consumes: `vp:copy`（M2 已有）
- Produces: `vp:studio/close`（invoke → main `getStudioWindow()?.close()`）

- [ ] **Step 1: 采用/复制/关闭**

`PolishView`：「采用」= `setText(output); setOutput('')`（润色结果替换编辑区原文）；「复制」= `vp.copy(text)`（复制编辑区当前内容）；「关闭」= `vp.closeStudio()`。`ipc.js` 加 `ipcMain.handle('vp:studio/close', () => { getStudioWindow()?.close(); return true; })`。

- [ ] **Step 2: 悬浮条「润色」按钮**

`App.tsx` reviewing 态动作区，在「复制」旁加：

```tsx
<button style={styles.button} onClick={() => void vp.openStudio(fullText)}>润色</button>
```

- [ ] **Step 3: 界面自测补断言 + 手动**

Run: `cd app && npm run build && VP_UI_SELFTEST=1 timeout 90 npx electron .`
Expected: 全绿。再真机走全流程验证「采用」后复制的是润色结果。

- [ ] **Step 4: Commit**

```bash
git add app/src/studio/PolishView.tsx app/src/App.tsx app/electron/ipc.js app/electron/preload.cjs app/src/global.d.ts
git commit -m "feat(studio): 采用/复制/关闭 + 悬浮条润色入口"
```

---

## Out of Scope（下一份计划）

历史视图（SQLite + FTS5 中文 trigram）、设置视图（快捷键可配置 + 冲突检测 + 触发模式 + 开机启动 + 职业词表）、首次引导弹窗、悬浮条换亮色、原文写入历史的数据流。
