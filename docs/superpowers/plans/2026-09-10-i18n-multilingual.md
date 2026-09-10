# 多语言（i18n）全链路 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 VoicePilot 桌面端加三语（zh-CN / zh-TW / en-US）全链路多语言：UI 文案 + 润色输出语言 + 内置词表，默认跟随系统、设置页可切、即时生效。

**Architecture:** 主进程是 locale 单一真源（meta 表存 `ui_language`）。共享字典放 `app/shared/i18n/`（.js ESM，主进程 node 直接 import、渲染进程 Vite import + .d.ts 类型）。切换语言时主进程广播 `vp:lang/changed`，各窗口 React Context 更新重渲染；托盘/窗口标题由主进程重建。繁体正文靠 OpenCC 在 session 层简→繁。

**Tech Stack:** Electron 44（Node 24.20.0）、React 19、Vite、node:sqlite、opencc-js（纯 JS 简繁转换）。

## Global Constraints

- 语言清单固定三种：`zh-CN`、`zh-TW`、`en-US`。
- 默认语言跟随系统：`app.getLocale()` 映射——`zh`→`zh-CN`、`zh-TW`/`zh-HK`→`zh-TW`、`en`→`en-US`、其余→`en-US`。
- meta 键名：`ui_language`；`default_scene` 从存 name 改为存 **id**（meta 键名改为 `default_scene_id`）。
- 产品名三语：zh-CN「VoicePilot 闻字」、zh-TW「VoicePilot 聞字」、en-US「VoicePilot」。
- 主进程是 `.js`（ESM），渲染进程是 `.tsx`（Vite）；`preload.cjs` 必须是 CommonJS。
- 所有新依赖只装到 `app/` 目录（`cd app && npm install ...`）。
- 测试无第三方框架：主进程用 `electron/selftest/*.js`（`VP_*_SELFTEST=1` 触发），渲染进程用 `src/uitest/run.tsx`（`VP_UI_SELFTEST=1` 触发）。
- 运行命令用 bash 语法（Windows Git Bash / macOS 通用）：`cd app && VP_XXX=1 npx electron .`。
- 每个 task 结束时提交，commit 信息用中文、格式 `feat: ...` 或 `refactor: ...`。

---

### Task 1: 共享 i18n 字典模块

**Files:**
- Create: `app/shared/i18n/zh-CN.js`
- Create: `app/shared/i18n/zh-TW.js`
- Create: `app/shared/i18n/en-US.js`
- Create: `app/shared/i18n/index.js`
- Create: `app/shared/i18n/index.d.ts`
- Create: `app/electron/selftest/i18n.js`
- Modify: `app/electron/main.js`（selftest 分支加 `VP_I18N_SELFTEST`）
- Modify: `app/tsconfig.json`（include 加 `"shared"`）

**Interfaces:**
- Consumes: 无。
- Produces:
  - `LOCALES = ['zh-CN', 'zh-TW', 'en-US']`
  - `type Locale = 'zh-CN' | 'zh-TW' | 'en-US'`
  - `t(locale: string, key: string, params?: Record<string, string|number>): string` — 缺 key 返回 key 本身；`{{name}}` 占位符替换。
  - `resolveLocale(sysLocale: string|null|undefined): Locale` — 映射规则见 Global Constraints。
  - `isLocale(x: unknown): x is Locale`

- [ ] **Step 1: 写三份字典**

`app/shared/i18n/zh-CN.js`：

```js
export const zhCN = {
  productName: 'VoicePilot 闻字',
  // 悬浮条
  'bar.warming': '准备中',
  'bar.listening': '聆听中',
  'bar.draining': '收尾中',
  'bar.reviewing': '已停止',
  'bar.retry': '（{{attempt}}/{{max}} 次重试）',
  'bar.polish': '润色',
  'bar.copy': '复制',
  'bar.close': '关闭',
  'bar.truncated': '收尾超时，已保留已识别内容',
  'bar.copied': '已复制到剪贴板',
  'bar.err.mic': '麦克风不可用，请检查是否被其他程序占用',
  'bar.err.clipboard': '复制失败，请重试',
  'bar.err.network': '网络连接中断',
  'bar.err.throttling': '服务繁忙，正在重试',
  'bar.err.key': '未获取到授权，请联系管理员',
  'bar.err.asr': '识别服务出错，已保留已识别内容',
  // 主应用导航
  'studio.polish': '润色',
  'studio.history': '历史',
  'studio.settings': '设置',
  // 润色工作区
  'polish.scene': '场景',
  'polish.tone': '语气',
  'polish.manage': '管理',
  'polish.run': '润色',
  'polish.running': '润色中…',
  'polish.original': '原文',
  'polish.result': '润色结果',
  'polish.placeholder': '在此输入或粘贴要润色的文本',
  'polish.adopt': '采用',
  'polish.copy': '复制',
  'polish.close': '关闭',
  'polish.copied': '已复制到剪贴板',
  'polish.errorPrefix': '润色失败：',
  // 历史
  'history.empty': '还没有历史记录',
  'history.polished': '已润色',
  'history.result': '润色结果',
  'history.copy': '复制',
  'history.polish': '润色',
  'history.copied': '已复制',
  'history.selectHint': '选中一条历史查看全文',
  'history.seconds': '秒',
  // 预设管理
  'preset.manageScene': '管理场景',
  'preset.manageTone': '管理语气',
  'preset.edit': '编辑',
  'preset.builtin': '内置',
  'preset.delete': '删除',
  'preset.name': '名称',
  'preset.descPlaceholder': '说明（可选，内联进润色提示词）',
  'preset.add': '新增',
  'preset.save': '保存',
  'preset.cancelEdit': '取消编辑',
  'preset.nameExists': '名称已存在',
  // 设置
  'settings.permissions': '权限',
  'settings.language': '语言',
  'settings.noPermNeeded': '本平台无需额外权限。',
  'settings.accessibility': '辅助功能（全局快捷键）',
  'settings.granted': '已授权 ✓',
  'settings.denied': '未授权 ✗',
  'settings.step1': '打开「系统设置」',
  'settings.step2': '进入「隐私与安全性」',
  'settings.step3Prefix': '点「辅助功能」，勾选',
  'settings.openSettings': '打开系统设置',
  // 欢迎页
  'onboarding.titlePrefix': '欢迎使用',
  'onboarding.intro': '按 {{shortcut}} 开始语音输入，说完自动生成文字，可一键复制或润色。',
  'onboarding.permissionMac': '请在系统设置中允许「麦克风」权限，并在「隐私与安全性 → 辅助功能」中允许 VoicePilot（全局快捷键需要）。',
  'onboarding.permissionWin': '首次使用请在系统设置中允许「麦克风」权限。',
  'onboarding.start': '开始使用',
  // 设置 API Key
  'key.title': '设置 API Key',
  'key.hint': '请填入管理员发给你的百炼凭据，保存后即可开始使用。',
  'key.apiKey': 'API Key',
  'key.workspaceId': '工作空间 ID（Workspace ID）',
  'key.wsPlaceholder': '业务空间 ID，不是 API Key',
  'key.saving': '保存中…',
  'key.save': '保存',
  'key.emptyError': 'API Key 和工作空间 ID 都不能为空',
  // 会话错误（主进程）
  'machine.busy': '服务繁忙',
  'machine.disconnected': '连接中断',
  'machine.retryExhausted': '{{message}}，已重试 {{attempt}} 次仍未成功',
  // 托盘
  'tray.openMain': '打开主应用',
  'tray.showBar': '显示悬浮条',
  'tray.hideBar': '隐藏悬浮条',
  'tray.diag': '采集诊断（M1）',
  'tray.setKey': '设置 API Key',
  'tray.quit': '退出',
  // 窗口标题
  'window.studio': 'VoicePilot 主应用',
  'window.diag': 'VoicePilot 采集诊断',
  'window.onboarding': '欢迎使用 VoicePilot 闻字',
  'window.keyEntry': '设置 API Key — VoicePilot 闻字',
};
```

`app/shared/i18n/zh-TW.js`（与 zh-CN 同 key，繁体文案）：

```js
export const zhTW = {
  productName: 'VoicePilot 聞字',
  'bar.warming': '準備中',
  'bar.listening': '聆聽中',
  'bar.draining': '收尾中',
  'bar.reviewing': '已停止',
  'bar.retry': '（{{attempt}}/{{max}} 次重試）',
  'bar.polish': '潤色',
  'bar.copy': '複製',
  'bar.close': '關閉',
  'bar.truncated': '收尾逾時，已保留已辨識內容',
  'bar.copied': '已複製到剪貼簿',
  'bar.err.mic': '麥克風不可用，請檢查是否被其他程式占用',
  'bar.err.clipboard': '複製失敗，請重試',
  'bar.err.network': '網路連線中斷',
  'bar.err.throttling': '服務繁忙，正在重試',
  'bar.err.key': '未取得授權，請聯絡管理員',
  'bar.err.asr': '辨識服務出錯，已保留已辨識內容',
  'studio.polish': '潤色',
  'studio.history': '歷史',
  'studio.settings': '設定',
  'polish.scene': '場景',
  'polish.tone': '語氣',
  'polish.manage': '管理',
  'polish.run': '潤色',
  'polish.running': '潤色中…',
  'polish.original': '原文',
  'polish.result': '潤色結果',
  'polish.placeholder': '在此輸入或貼上要潤色的文字',
  'polish.adopt': '採用',
  'polish.copy': '複製',
  'polish.close': '關閉',
  'polish.copied': '已複製到剪貼簿',
  'polish.errorPrefix': '潤色失敗：',
  'history.empty': '還沒有歷史紀錄',
  'history.polished': '已潤色',
  'history.result': '潤色結果',
  'history.copy': '複製',
  'history.polish': '潤色',
  'history.copied': '已複製',
  'history.selectHint': '選取一則歷史查看全文',
  'history.seconds': '秒',
  'preset.manageScene': '管理場景',
  'preset.manageTone': '管理語氣',
  'preset.edit': '編輯',
  'preset.builtin': '內建',
  'preset.delete': '刪除',
  'preset.name': '名稱',
  'preset.descPlaceholder': '說明（可選，內聯進潤色提示詞）',
  'preset.add': '新增',
  'preset.save': '儲存',
  'preset.cancelEdit': '取消編輯',
  'preset.nameExists': '名稱已存在',
  'settings.permissions': '權限',
  'settings.language': '語言',
  'settings.noPermNeeded': '此平台無需額外權限。',
  'settings.accessibility': '輔助功能（全域快捷鍵）',
  'settings.granted': '已授權 ✓',
  'settings.denied': '未授權 ✗',
  'settings.step1': '開啟「系統設定」',
  'settings.step2': '進入「隱私與安全性」',
  'settings.step3Prefix': '點「輔助功能」，勾選',
  'settings.openSettings': '開啟系統設定',
  'onboarding.titlePrefix': '歡迎使用',
  'onboarding.intro': '按 {{shortcut}} 開始語音輸入，說完自動產生文字，可一鍵複製或潤色。',
  'onboarding.permissionMac': '請在系統設定中允許「麥克風」權限，並在「隱私與安全性 → 輔助功能」中允許 VoicePilot（全域快捷鍵需要）。',
  'onboarding.permissionWin': '首次使用請在系統設定中允許「麥克風」權限。',
  'onboarding.start': '開始使用',
  'key.title': '設定 API Key',
  'key.hint': '請填入管理員發給你的百煉憑據，儲存後即可開始使用。',
  'key.apiKey': 'API Key',
  'key.workspaceId': '工作區 ID（Workspace ID）',
  'key.wsPlaceholder': '業務空間 ID，不是 API Key',
  'key.saving': '儲存中…',
  'key.save': '儲存',
  'key.emptyError': 'API Key 和工作區 ID 都不能為空',
  'machine.busy': '服務繁忙',
  'machine.disconnected': '連線中斷',
  'machine.retryExhausted': '{{message}}，已重試 {{attempt}} 次仍未成功',
  'tray.openMain': '開啟主應用',
  'tray.showBar': '顯示懸浮條',
  'tray.hideBar': '隱藏懸浮條',
  'tray.diag': '採集診斷（M1）',
  'tray.setKey': '設定 API Key',
  'tray.quit': '退出',
  'window.studio': 'VoicePilot 主應用',
  'window.diag': 'VoicePilot 採集診斷',
  'window.onboarding': '歡迎使用 VoicePilot 聞字',
  'window.keyEntry': '設定 API Key — VoicePilot 聞字',
};
```

`app/shared/i18n/en-US.js`：

```js
export const enUS = {
  productName: 'VoicePilot',
  'bar.warming': 'Warming up',
  'bar.listening': 'Listening',
  'bar.draining': 'Finishing',
  'bar.reviewing': 'Stopped',
  'bar.retry': '(retry {{attempt}}/{{max}})',
  'bar.polish': 'Polish',
  'bar.copy': 'Copy',
  'bar.close': 'Close',
  'bar.truncated': 'Timed out, recognized text kept',
  'bar.copied': 'Copied to clipboard',
  'bar.err.mic': 'Microphone unavailable — check if another app is using it',
  'bar.err.clipboard': 'Copy failed, please retry',
  'bar.err.network': 'Network disconnected',
  'bar.err.throttling': 'Server busy, retrying',
  'bar.err.key': 'Not authorized — contact your admin',
  'bar.err.asr': 'Recognition error, recognized text kept',
  'studio.polish': 'Polish',
  'studio.history': 'History',
  'studio.settings': 'Settings',
  'polish.scene': 'Scene',
  'polish.tone': 'Tone',
  'polish.manage': 'Manage',
  'polish.run': 'Polish',
  'polish.running': 'Polishing…',
  'polish.original': 'Original',
  'polish.result': 'Result',
  'polish.placeholder': 'Type or paste text to polish',
  'polish.adopt': 'Adopt',
  'polish.copy': 'Copy',
  'polish.close': 'Close',
  'polish.copied': 'Copied to clipboard',
  'polish.errorPrefix': 'Polish failed: ',
  'history.empty': 'No history yet',
  'history.polished': 'Polished',
  'history.result': 'Result',
  'history.copy': 'Copy',
  'history.polish': 'Polish',
  'history.copied': 'Copied',
  'history.selectHint': 'Select a record to view',
  'history.seconds': 's',
  'preset.manageScene': 'Manage scenes',
  'preset.manageTone': 'Manage tones',
  'preset.edit': 'Edit',
  'preset.builtin': 'Built-in',
  'preset.delete': 'Delete',
  'preset.name': 'Name',
  'preset.descPlaceholder': 'Description (optional, inlined into the polish prompt)',
  'preset.add': 'Add',
  'preset.save': 'Save',
  'preset.cancelEdit': 'Cancel',
  'preset.nameExists': 'Name already exists',
  'settings.permissions': 'Permissions',
  'settings.language': 'Language',
  'settings.noPermNeeded': 'No extra permissions needed on this platform.',
  'settings.accessibility': 'Accessibility (global shortcut)',
  'settings.granted': 'Granted ✓',
  'settings.denied': 'Not granted ✗',
  'settings.step1': 'Open System Settings',
  'settings.step2': 'Go to Privacy & Security',
  'settings.step3Prefix': 'Click Accessibility, then enable',
  'settings.openSettings': 'Open System Settings',
  'onboarding.titlePrefix': 'Welcome to',
  'onboarding.intro': 'Press {{shortcut}} to start voice input. Your speech becomes text — copy or polish in one click.',
  'onboarding.permissionMac': 'Allow Microphone access in System Settings, and enable VoicePilot under Privacy & Security → Accessibility (required for the global shortcut).',
  'onboarding.permissionWin': 'Allow Microphone access in System Settings on first use.',
  'onboarding.start': 'Get Started',
  'key.title': 'Set API Key',
  'key.hint': 'Enter the DashScope credentials from your admin, then you are ready to go.',
  'key.apiKey': 'API Key',
  'key.workspaceId': 'Workspace ID',
  'key.wsPlaceholder': 'Workspace ID, not the API Key',
  'key.saving': 'Saving…',
  'key.save': 'Save',
  'key.emptyError': 'API Key and Workspace ID are both required',
  'machine.busy': 'Server busy',
  'machine.disconnected': 'Connection lost',
  'machine.retryExhausted': '{{message}}, retried {{attempt}} times without success',
  'tray.openMain': 'Open Main App',
  'tray.showBar': 'Show Bar',
  'tray.hideBar': 'Hide Bar',
  'tray.diag': 'Capture Diagnostic (M1)',
  'tray.setKey': 'Set API Key',
  'tray.quit': 'Quit',
  'window.studio': 'VoicePilot Main',
  'window.diag': 'VoicePilot Capture Diagnostic',
  'window.onboarding': 'Welcome to VoicePilot',
  'window.keyEntry': 'Set API Key — VoicePilot',
};
```

- [ ] **Step 2: 写 `app/shared/i18n/index.js`**

```js
import { zhCN } from './zh-CN.js';
import { zhTW } from './zh-TW.js';
import { enUS } from './en-US.js';

export const LOCALES = ['zh-CN', 'zh-TW', 'en-US'];
export const DICTS = { 'zh-CN': zhCN, 'zh-TW': zhTW, 'en-US': enUS };

export function isLocale(x) {
  return typeof x === 'string' && LOCALES.includes(x);
}

/** 系统语言 → 三语之一；未知一律 en-US。 */
export function resolveLocale(sysLocale) {
  const s = String(sysLocale ?? '').toLowerCase();
  if (s.startsWith('zh')) {
    if (s.includes('tw') || s.includes('hk') || s.includes('mo')) return 'zh-TW';
    return 'zh-CN';
  }
  if (s.startsWith('en')) return 'en-US';
  return 'en-US';
}

/** 翻译。缺 key 返回 key 本身（便于发现遗漏）；{{name}} 占位符替换。 */
export function t(locale, key, params = {}) {
  const dict = DICTS[locale] ?? enUS;
  const raw = dict[key];
  if (raw == null) return key;
  return raw.replace(/\{\{(\w+)\}\}/g, (_, name) =>
    name in params ? String(params[name]) : `{{${name}}}`
  );
}
```

- [ ] **Step 3: 写 `app/shared/i18n/index.d.ts`**

```ts
export type Locale = 'zh-CN' | 'zh-TW' | 'en-US';
export const LOCALES: Locale[];
export function isLocale(x: unknown): x is Locale;
export function resolveLocale(sysLocale: string | null | undefined): Locale;
export function t(
  locale: string,
  key: string,
  params?: Record<string, string | number>
): string;
```

- [ ] **Step 4: 调整 `app/tsconfig.json`**

把 `"include": ["src", "vite.config.ts"]` 改为 `"include": ["src", "shared", "vite.config.ts"]`。

- [ ] **Step 5: 写 selftest `app/electron/selftest/i18n.js`**

```js
import { t, resolveLocale, isLocale, LOCALES } from '../../shared/i18n/index.js';

export async function runI18nSelftest() {
  console.log('[自测] i18n 字典');
  const okT = t('zh-CN', 'bar.listening') === '聆听中' &&
    t('zh-TW', 'bar.listening') === '聆聽中' &&
    t('en-US', 'bar.listening') === 'Listening';
  const okParams = t('en-US', 'bar.retry', { attempt: 2, max: 3 }) === '(retry 2/3)';
  const okMissing = t('zh-CN', 'nope.nope') === 'nope.nope';
  const okResolve = resolveLocale('zh-CN') === 'zh-CN' &&
    resolveLocale('zh-TW') === 'zh-TW' &&
    resolveLocale('zh-HK') === 'zh-TW' &&
    resolveLocale('en') === 'en-US' &&
    resolveLocale('ja') === 'en-US' &&
    resolveLocale(null) === 'en-US';
  const okIs = isLocale('zh-CN') && !isLocale('ja') && !isLocale(3);
  const okSameKeys = new Set(LOCALES.map((l) => Object.keys(t(l, '__x')).length)).size <= 1;
  const ok = okT && okParams && okMissing && okResolve && okIs;
  console.log(`[自测] ${ok ? '通过' : '失败'} t=${okT} 占位=${okParams} 缺key=${okMissing} 映射=${okResolve} isLocale=${okIs}`);
  return { ok };
}
```

- [ ] **Step 6: 在 `app/electron/main.js` 接 selftest 分支**

在 `whenReady` 里的 `selftest` 三元链（约 main.js:351-359）加一项：`process.env.VP_I18N_SELFTEST ? './selftest/i18n.js' : ...`；并把 `run` 解构处（main.js:369）加 `?? mod.runI18nSelftest`。

- [ ] **Step 7: 跑测试**

Run: `cd app && VP_I18N_SELFTEST=1 npx electron .`
Expected: 输出 `[自测] 通过`，进程退出码 0。

- [ ] **Step 8: Commit**

```bash
git add app/shared/i18n app/electron/selftest/i18n.js app/electron/main.js app/tsconfig.json
git commit -m "feat: 共享 i18n 字典模块（三语 + t/resolveLocale + selftest）"
```

---

### Task 2: 主进程 locale 状态与 IPC

**Files:**
- Create: `app/electron/locale.js`（locale 单一真源 + 持久化）
- Modify: `app/electron/ipc.js`（`vp:lang/get` / `vp:lang/set`，广播 `vp:lang/changed`）
- Modify: `app/electron/preload.cjs`（桥接 `getLanguage` / `setLanguage` / `onLanguageChanged`）
- Modify: `app/src/global.d.ts`（补类型）

**Interfaces:**
- Consumes: `t` / `resolveLocale` / `isLocale`（Task 1）；`getMeta` / `setMeta`（store.js 已有）。
- Produces:
  - `getCurrentLocale(): Locale`（locale.js，惰性初始化自 meta/系统语言）
  - `setCurrentLocale(locale): boolean`（locale.js，校验 + 持久化）
  - IPC `vp:lang/get` → `{ locale: Locale }`
  - IPC `vp:lang/set(locale)` → `{ ok: boolean; locale: Locale }`（非法 locale 返回 `{ ok:false }`）
  - 事件 `vp:lang/changed(locale)` → 广播给所有窗口
  - preload: `getLanguage()`, `setLanguage(locale)`, `onLanguageChanged(cb)`

- [ ] **Step 1: 写 `app/electron/locale.js`**

```js
import { app } from 'electron';
import { resolveLocale, isLocale } from '../shared/i18n/index.js';
import { getMeta, setMeta } from './store.js';

let current = null;

export function getCurrentLocale() {
  if (current === null) {
    current = resolveLocale(getMeta('ui_language') ?? app.getLocale());
  }
  return current;
}

export function setCurrentLocale(locale) {
  if (!isLocale(locale)) return false;
  current = locale;
  setMeta('ui_language', locale);
  return true;
}
```

- [ ] **Step 1b: ipc.js 接入 locale + 广播**

`app/electron/ipc.js` 顶部 import 区加：

```js
import { BrowserWindow } from 'electron';
import { getCurrentLocale, setCurrentLocale } from './locale.js';
```

`registerIpc` 函数签名加一个参数 `rebuildTray`，即 `registerIpc({ getBar, requestQuit, attachDevLogging, resizeBar, rebuildTray })`。

函数体开头（`const machine = new SessionMachine(...)` 之前）加：

```js
function broadcastLocale(locale) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('vp:lang/changed', locale);
  }
}
```

- [ ] **Step 2: 加两个 handler**

在 `registerIpc` 内、权限（F12）区块之前加：

```js
// ---------------------------------------------------------------- 语言（i18n）

ipcMain.handle('vp:lang/get', () => ({ locale: getCurrentLocale() }));

ipcMain.handle('vp:lang/set', (_e, locale) => {
  const ok = setCurrentLocale(locale);
  if (!ok) return { ok: false, locale: getCurrentLocale() };
  broadcastLocale(locale);
  rebuildTray?.();
  return { ok: true, locale };
});
```

- [ ] **Step 3: 更新 `app/electron/main.js` 传参**

`registerIpc` 调用处（main.js:347）加 `rebuildTray: () => {}`（Task 3 实现真正的 rebuildTray）。`registerIpc` 返回 machine 不变，`const machine = registerIpc({...})` 保持原样。

- [ ] **Step 4: `app/electron/preload.cjs` 加桥**

在 `contextBridge.exposeInMainWorld('voicepilot', {...})` 里、权限区块之后加：

```js
// ---------------------------------------------------------------- 语言（i18n）

getLanguage() {
  return ipcRenderer.invoke('vp:lang/get');
},

setLanguage(locale) {
  return ipcRenderer.invoke('vp:lang/set', locale);
},

/** @param cb 收到新的 locale（'zh-CN' | 'zh-TW' | 'en-US'） */
onLanguageChanged(cb) {
  return subscribe('vp:lang/changed', cb);
},
```

- [ ] **Step 5: `app/src/global.d.ts` 补类型**

在 `VoicePilotBridge` 接口里、权限区块之后加：

```ts
// —— 语言（i18n）——
getLanguage(): Promise<{ locale: 'zh-CN' | 'zh-TW' | 'en-US' }>;
setLanguage(locale: 'zh-CN' | 'zh-TW' | 'en-US'): Promise<{ ok: boolean; locale: 'zh-CN' | 'zh-TW' | 'en-US' }>;
onLanguageChanged(cb: (locale: 'zh-CN' | 'zh-TW' | 'en-US') => void): () => void;
```

- [ ] **Step 6: 更新 `app/electron/main.js` 传参**

`registerIpc` 调用处（main.js:347）加 `rebuildTray`。先传空函数占位（Task 3 会实现真正的 rebuildTray）：`rebuildTray: () => {}`，并把返回值解构改掉（见 Step 3）。

- [ ] **Step 7: 更新 i18n selftest 覆盖 IPC**

在 `app/electron/selftest/i18n.js` 末尾追加一条校验（无需真窗口，只验 `vp:lang/set` 的持久化）：

```js
// 在 runI18nSelftest 内、return 之前
setMeta('ui_language', 'zh-TW');
const okPersist = getMeta('ui_language') === 'zh-TW';
```

需在文件顶部 import `{ getMeta, setMeta } from '../store.js'`，并 `openStore(':memory:')`。

- [ ] **Step 8: 跑测试**

Run: `cd app && VP_I18N_SELFTEST=1 npx electron .`
Expected: 通过，退出码 0。

- [ ] **Step 9: Commit**

```bash
git add app/electron/ipc.js app/electron/preload.cjs app/src/global.d.ts app/electron/main.js app/electron/selftest/i18n.js
git commit -m "feat: 主进程 locale 状态 + vp:lang IPC 桥"
```

---

### Task 3: 主进程文案 i18n（托盘 / 窗口标题 / 会话错误 / 润色 prompt）

**Files:**
- Modify: `app/electron/main.js`（托盘菜单/tooltip 走 `t()`、实现 `rebuildTray`、窗口标题）
- Modify: `app/electron/studio.js`（标题走 `t()`）
- Modify: `app/electron/onboarding.js`（标题走 `t()`）
- Modify: `app/electron/key-entry.js`（标题走 `t()`）
- Modify: `app/electron/session/machine.js`（错误文案走 `t()`）
- Modify: `app/electron/llm/prompt.js`（输出语言指令）

**Interfaces:**
- Consumes: `getCurrentLocale`（Task 2，从 registerIpc 返回值解构）、`t`（Task 1）。
- Produces: `rebuildTray()`（main.js 内部函数，重建托盘用当前 locale）；`buildPolishMessages(text, scene, tone)` 追加输出语言参数。

- [ ] **Step 1: main.js 引入 t 与 locale**

顶部 import 加：

```js
import { t } from '../shared/i18n/index.js';
import { getCurrentLocale } from './locale.js';
```

实现 `rebuildTray`（main.js 模块级）：

```js
function rebuildTray() {
  if (!tray || tray.isDestroyed()) return;
  const locale = getCurrentLocale();
  tray.setToolTip(t(locale, 'productName'));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t(locale, 'tray.openMain'), click: () => createStudioWindow({ attachDevLogging }) },
    { type: 'separator' },
    { label: t(locale, 'tray.showBar'), click: () => bar?.showInactive() },
    { label: t(locale, 'tray.hideBar'), click: () => bar?.hide() },
    { type: 'separator' },
    { label: t(locale, 'tray.diag'), click: () => createDiagWindow() },
    { type: 'separator' },
    { label: t(locale, 'tray.setKey'), click: () => createKeyEntryWindow({ attachDevLogging }) },
    { type: 'separator' },
    { label: t(locale, 'tray.quit'), click: () => requestQuit() },
  ]));
}
```

- [ ] **Step 2: 托盘 createTray 改用 rebuildTray**

把 `createTray()` 函数体里的 `tray.setToolTip('VoicePilot 闻字')` 和 `tray.setContextMenu(Menu.buildFromTemplate([...]))` 两块删掉，改为调用 `rebuildTray()`（菜单模板集中到 Step 1 的 `rebuildTray`）。`createTray` 只保留创建 Tray 对象 + 设置图标。

- [ ] **Step 3: 窗口标题走 t()**

各窗口文件顶部 `import { t } from '../shared/i18n/index.js';` + `import { getCurrentLocale } from './locale.js';`：

- `studio.js:29` → `title: t(getCurrentLocale(), 'window.studio')`
- `onboarding.js:24` → `title: t(getCurrentLocale(), 'window.onboarding')`
- `key-entry.js:26` → `title: t(getCurrentLocale(), 'window.keyEntry')`
- `main.js:250`（diag 窗口）→ `title: t(getCurrentLocale(), 'window.diag')`

- [ ] **Step 4: machine.js 错误文案走 t()**

`machine.js` 顶部 import `{ t } from '../../shared/i18n/index.js';` 和 `{ getCurrentLocale } from '../locale.js';`。把：
- `#onSessionError` 里的 `'服务繁忙'` → `t(getCurrentLocale(), 'machine.busy')`
- `#onSessionClosed` 里的 `'服务繁忙'` / `'连接中断'` → `t(getCurrentLocale(), 'machine.busy' | 'machine.disconnected')`
- `#scheduleRetry` 里 `\`${message}，已重试 ${this.#attempt} 次仍未成功\`` → `t(getCurrentLocale(), 'machine.retryExhausted', { message, attempt: this.#attempt })`

注意 `#scheduleRetry` 的 message 参数在调用点已由 `#onSessionError`/`#onSessionClosed` 传入了翻译后的文案，所以模板里的 `{{message}}` 无需二次翻译。

- [ ] **Step 5: prompt.js 加输出语言指令**

`buildPolishMessages` 增加一个 `outputLang` 参数（'zh' | 'en'，由调用方按输入文本语种判定），system 里追加一句：

```js
export function buildPolishMessages(text, scene, tone, outputLang = 'zh') {
  const langLine = outputLang === 'en'
    ? 'Output in the same language as the user input.'
    : '输出语言与用户输入一致。';
  // ...system 里 `${sceneLine}\n${toneLine}` 之后加 `\n${langLine}`
}
```

（繁简不在这里管——Task 7 的 OpenCC 已在 ASR 结果侧把正文转成繁体，润色输入即繁体。）

- [ ] **Step 6: 检查 polish.js 调用点**

`app/electron/llm/polish.js` 调 `buildPolishMessages` 处，需传入 `outputLang`。判定函数：文本含 `[\u4e00-\u9fff]` → 'zh'，否则 'en'。在 polish.js 内加一个 `detectLang(text)` 辅助或直接内联。

- [ ] **Step 7: 跑现有 selftest 防回归**

Run: `cd app && VP_POLISH_SELFTEST=1 npx electron .` 和 `cd app && VP_SM_SELFTEST=1 npx electron .`
Expected: 均通过（polish selftest 若有 prompt 断言，需同步更新——见 Step 8）。

- [ ] **Step 8: 更新 polish selftest 的 prompt 断言**

读 `app/electron/selftest/polish.js`，若它断言了 `buildPolishMessages` 的 system 内容，改为包含新的 `outputLang` 参数断言。

- [ ] **Step 9: Commit**

```bash
git add app/electron/locale.js app/electron/main.js app/electron/studio.js app/electron/onboarding.js app/electron/key-entry.js app/electron/session/machine.js app/electron/llm/prompt.js app/electron/llm/polish.js app/electron/selftest/polish.js
git commit -m "feat: 主进程文案 i18n + 润色输出语言指令"
```

---

### Task 4: 渲染进程 i18n 基础设施 + 悬浮条接入

**Files:**
- Create: `app/src/i18n.tsx`（LocaleContext + `useLocale` / `useT` hook）
- Modify: `app/src/main.tsx`（Provider 包裹 + 初始化 locale + 订阅变更）
- Modify: `app/src/App.tsx`（LABEL / ERROR_TEXT / 按钮 / 提示走 `useT`）

**Interfaces:**
- Consumes: `t`（Task 1）、`getLanguage` / `onLanguageChanged`（Task 2）。
- Produces: `<I18nProvider bridge>`、`useT()`（返回 `(key, params?) => string`）、`useLocale()`（返回当前 locale）。

- [ ] **Step 1: 写 `app/src/i18n.tsx`**

```tsx
import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { t, resolveLocale } from '../shared/i18n/index.js';

type Locale = 'zh-CN' | 'zh-TW' | 'en-US';

const LocaleContext = createContext<Locale>('zh-CN');

export function I18nProvider({ bridge, children }: {
  bridge?: Window['voicepilot'];
  children: ReactNode;
}) {
  const vp = bridge ?? window.voicepilot;
  const [locale, setLocale] = useState<Locale>(() =>
    resolveLocale(typeof navigator !== 'undefined' ? navigator.language : null)
  );

  useEffect(() => {
    void vp.getLanguage().then((r) => setLocale(r.locale));
    const off = vp.onLanguageChanged((l) => setLocale(l));
    return off;
  }, [vp]);

  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

export function useT() {
  const locale = useLocale();
  return (key: string, params?: Record<string, string | number>) => t(locale, key, params);
}
```

- [ ] **Step 2: main.tsx 包 Provider**

`boot()` 里每个 `createRoot(...).render(...)` 的组件都包一层 `<I18nProvider>`。最省事的方式：写一个 `render(el, node)` 辅助：

```tsx
function render(node: ReactNode) {
  createRoot(container).render(<I18nProvider>{node}</I18nProvider>);
}
```

然后把 4 处 `createRoot(container).render(<X />)` 都改成 `render(<X />)`。（uitest 分支不动——它直接跑断言，不挂 Provider。）

- [ ] **Step 3: App.tsx 文案走 useT**

在 `App` 组件内 `const t = useT();`，替换：
- `LABEL` 常量删除，改为 `const LABEL: Record<SessionState, string> = { warming: t('bar.warming'), listening: t('bar.listening'), draining: t('bar.draining'), reviewing: t('bar.reviewing'), idle: '' };`（放在组件体内，随 locale 重渲染）。
- `ERROR_TEXT` 同理改为组件内映射：`{ mic: t('bar.err.mic'), clipboard: t('bar.err.clipboard'), network: t('bar.err.network'), throttling: t('bar.err.throttling'), key: t('bar.err.key'), asr: t('bar.err.asr') }`。
- 按钮「润色/复制/关闭」→ `t('bar.polish')` / `t('bar.copy')` / `t('bar.close')`。
- `收尾超时，已保留已识别内容` → `t('bar.truncated')`。
- `已复制到剪贴板` → `t('bar.copied')`。
- `（${attempt}/${max} 次重试）` → `t('bar.retry', { attempt, max: maxAttempts })`。
- `复制失败，请重试`（copy 里的 showError）→ `t('bar.err.clipboard')`。

注意：`LABEL` / `ERROR_TEXT` 从模块级移到组件内后，依赖 locale 状态，会自动随切换重渲染（这正是即时生效的机制）。

- [ ] **Step 4: 跑 uitest 确认无回归**

Run: `cd app && VP_UI_SELFTEST=1 npx electron .`
Expected: 通过（断言里的中文文案如「准备中」「复制」在 zh-CN 下不变，仍能匹配）。

- [ ] **Step 5: Commit**

```bash
git add app/src/i18n.tsx app/src/main.tsx app/src/App.tsx
git commit -m "feat: 渲染进程 i18n Provider + 悬浮条文案接入"
```

---

### Task 5: Studio 各视图 + 欢迎页 + KeyEntry 文案接入 + 语言选择器

**Files:**
- Modify: `app/src/studio/Studio.tsx`
- Modify: `app/src/studio/PolishView.tsx`
- Modify: `app/src/studio/HistoryView.tsx`
- Modify: `app/src/studio/PresetManager.tsx`
- Modify: `app/src/studio/SettingsView.tsx`（加语言选择器）
- Modify: `app/src/onboarding/Onboarding.tsx`
- Modify: `app/src/key-entry/KeyEntry.tsx`

**Interfaces:**
- Consumes: `useT` / `useLocale`（Task 4）、`setLanguage`（Task 2）。

- [ ] **Step 1: Studio.tsx**

`NAV` 从模块常量改为组件内（或用 `useT` 取 label）。组件内 `const t = useT();`，`NAV` 改为 `[{ key:'polish', label: t('studio.polish') }, { key:'history', label: t('studio.history') }, { key:'settings', label: t('studio.settings') }]`。

- [ ] **Step 2: PolishView.tsx**

组件内 `const t = useT();`，替换：场景/语气/管理/润色/润色中…/原文/润色结果/placeholder/采用/复制/关闭/已复制到剪贴板/`润色失败：{msg}` → `t('polish.errorPrefix') + msg`。

- [ ] **Step 3: HistoryView.tsx**

替换：还没有历史记录/已润色/润色结果/复制/润色/已复制/选中一条历史查看全文/秒（`Math.round(...) + ' ' + t('history.seconds')`）。

- [ ] **Step 4: PresetManager.tsx**

替换：管理场景/管理语气/编辑/内置/删除/名称/说明 placeholder/新增/保存/取消编辑/名称已存在。

- [ ] **Step 5: SettingsView.tsx 加语言选择器**

在「权限」区块之前加「语言」区块：

```tsx
const t = useT();
const locale = useLocale();
// ...
<div style={styles.block}>
  <span style={styles.label}>{t('settings.language')}</span>
  <select
    data-testid="settings-lang"
    style={styles.select}
    value={locale}
    onChange={(e) => void vp.setLanguage(e.target.value as Locale)}
  >
    <option value="zh-CN">简体中文</option>
    <option value="zh-TW">繁體中文</option>
    <option value="en-US">English</option>
  </select>
</div>
```

（语言名本身用母语显示，不随当前语言翻译，这是惯例。）其余权限文案全部走 `t(...)`。

- [ ] **Step 6: Onboarding.tsx**

替换：`欢迎使用`（`t('onboarding.titlePrefix')` + 空格 + `t('productName')`）/ intro（`t('onboarding.intro', { shortcut })`）/ permissionMac / permissionWin / 开始使用。

- [ ] **Step 7: KeyEntry.tsx**

替换：设置 API Key/hint/API Key/工作空间 ID/wsPlaceholder/保存中…/保存/空值错误。

- [ ] **Step 8: 跑 uitest 确认无回归 + typecheck**

Run: `cd app && VP_UI_SELFTEST=1 npx electron .` 和 `cd app && npm run typecheck`
Expected: 通过；typecheck 无错误。

- [ ] **Step 9: Commit**

```bash
git add app/src/studio app/src/onboarding app/src/key-entry
git commit -m "feat: Studio/欢迎页/KeyEntry 文案接入 + 设置页语言选择器"
```

---

### Task 6: 词表三语 + default_scene 改 id

**Files:**
- Modify: `app/electron/store.js`（schema 加三语列 + lang；seed 三语；listPresets/savePreset 改造）
- Modify: `app/electron/ipc.js`（`vp:studio/sync` 返回按 locale 的三语名；`default_scene_id` 读写）
- Modify: `app/electron/selftest/store.js`（更新断言）
- Modify: `app/src/studio/PolishView.tsx`（defaultScene 按 id 匹配）

**Interfaces:**
- Consumes: `getCurrentLocale`（Task 3）。
- Produces:
  - `listPresets(kind, locale)` → 返回 `{ id, name, description, is_builtin, lang }[]`，其中 `name` 已按 locale 解析（内置取对应三语列，自定义取原 name）。
  - `savePreset({ id, kind, name, description, lang })` → 自定义预设写 `lang`。
  - `syncStudio` 返回 `defaultSceneId: number | null`（替代原 `defaultScene: string | null`）。

- [ ] **Step 1: store.js schema 迁移**

`SCHEMA` 里 presets 表改为：

```sql
CREATE TABLE IF NOT EXISTS presets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK(kind IN ('scene','tone')),
  name        TEXT NOT NULL,
  name_zh_cn  TEXT,
  name_zh_tw  TEXT,
  name_en     TEXT,
  description TEXT NOT NULL DEFAULT '',
  lang        TEXT,
  is_builtin  INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(kind, name)
);
```

`openStore` 里 `db.exec(SCHEMA)` 后加迁移（新列不存在时逐个补）：

```js
function migratePresets() {
  const cols = db.prepare('PRAGMA table_info(presets)').all().map((c) => c.name);
  const add = (name, ddl) => {
    if (!cols.includes(name)) db.exec(ddl);
  };
  add('name_zh_cn', 'ALTER TABLE presets ADD COLUMN name_zh_cn TEXT');
  add('name_zh_tw', 'ALTER TABLE presets ADD COLUMN name_zh_tw TEXT');
  add('name_en', 'ALTER TABLE presets ADD COLUMN name_en TEXT');
  add('lang', 'ALTER TABLE presets ADD COLUMN lang TEXT');
}
```

`openStore` 内 `db.exec(SCHEMA); migratePresets(); seedPresets();`。

- [ ] **Step 2: seed 三语**

`BUILTIN_SCENES` / `BUILTIN_TONES` 改为三语对象：

```js
const BUILTIN_SCENES = [
  ['文档', '文檔', 'Document'],
  ['邮件', '郵件', 'Email'],
  ['即时通讯', '即時通訊', 'Instant Messaging'],
  ['社媒', '社媒', 'Social Media'],
];
const BUILTIN_TONES = [
  ['正式', '正式', 'Formal'],
  ['口语', '口語', 'Casual'],
  ['简洁', '簡潔', 'Concise'],
  ['热情', '熱情', 'Warm'],
];
```

`seedPresets` 的 INSERT 改为写 `(kind, name, name_zh_cn, name_zh_tw, name_en, description, is_builtin, sort_order)`，`name` 存 zh-CN 名，`lang` 为 NULL。

- [ ] **Step 3: listPresets 按 locale 解析**

```js
export function listPresets(kind, locale = 'zh-CN') {
  openStore();
  const rows = db
    .prepare('SELECT id, name, name_zh_cn, name_zh_tw, name_en, description, lang, is_builtin FROM presets WHERE kind = ? ORDER BY sort_order, id')
    .all(kind);
  return rows.map((r) => {
    const name = r.is_builtin
      ? (locale === 'zh-TW' ? r.name_zh_tw : locale === 'en-US' ? r.name_en : r.name_zh_cn) ?? r.name
      : r.name;
    return { id: r.id, name, description: r.description, lang: r.lang, is_builtin: r.is_builtin };
  });
}
```

- [ ] **Step 4: savePreset 写 lang**

`savePreset({ id, kind, name, description = '', lang = null })`：INSERT 时把 `lang` 写入；UPDATE 时若传了 lang 也更新。删除逻辑不变。

- [ ] **Step 5: ipc.js 三语 + default_scene_id**

`vp:studio/sync`（ipc.js:156-161）改为：

```js
ipcMain.handle('vp:studio/sync', () => {
  const locale = getCurrentLocale();
  return {
    text: pendingStudioText,
    scenes: listPresets('scene', locale),
    tones: listPresets('tone', locale),
    defaultSceneId: getMeta('default_scene_id') ? Number(getMeta('default_scene_id')) : null,
  };
});
```

`vp:polish/start`（ipc.js:186-203）里 `setMeta('default_scene', scene.name)` 改为 `setMeta('default_scene_id', scene.id)`。注意 `scene` 现在是带 `id` 的对象，`scene.name` 是当前 locale 名，`scene.id` 是稳定 id。

- [ ] **Step 6: 更新 global.d.ts 的 Preset 与 syncStudio 类型**

`Preset` 接口加 `lang: string | null`；`syncStudio` 返回类型改 `defaultScene: string | null` → `defaultSceneId: number | null`。

- [ ] **Step 7: PolishView.tsx 按 id 匹配默认场景**

`useEffect` 里 `setScene(s.scenes.find((p) => p.name === s.defaultScene) ?? ...)` 改为 `setScene(s.scenes.find((p) => p.id === s.defaultSceneId) ?? ...)`，state 类型相应改 `defaultSceneId`。

- [ ] **Step 8: 更新 selftest/store.js**

断言 `scenes[0]?.name === '文档'` 改为校验三语：`listPresets('scene','zh-TW')[0].name === '文檔'` 且 `listPresets('scene','en-US')[0].name === 'Document'`；`savePreset` 用例加 `lang: 'zh-CN'` 校验回读。

- [ ] **Step 9: 跑 store selftest + uitest**

Run: `cd app && VP_STORE_SELFTEST=1 npx electron .` 和 `cd app && VP_UI_SELFTEST=1 npx electron .`
Expected: 均通过。

- [ ] **Step 10: Commit**

```bash
git add app/electron/store.js app/electron/ipc.js app/electron/selftest/store.js app/src/global.d.ts app/src/studio/PolishView.tsx
git commit -m "feat: 词表三语 + default_scene 改存 id"
```

---

### Task 7: OpenCC 简繁转换

**Files:**
- Modify: `app/electron/session/machine.js`（onResult 里做简→繁）
- Create: `app/electron/i18n/zh-convert.js`（opencc 封装，惰性加载）
- Modify: `app/electron/selftest/i18n.js`（加转换断言）
- Modify: `app/package.json`（依赖 opencc-js）

**Interfaces:**
- Consumes: `getCurrentLocale`（Task 3）。
- Produces: `toTraditional(text: string): Promise<string>`（opencc-js 惰性单例）。

- [ ] **Step 1: 装依赖**

Run: `cd app && npm install opencc-js`

- [ ] **Step 2: 写 `app/electron/i18n/zh-convert.js`**

```js
import { getCurrentLocale } from '../locale.js';

let converter = null;
let loading = null;

async function getConverter() {
  if (converter) return converter;
  if (!loading) {
    loading = import('opencc-js')
      .then(({ Converter }) => {
        converter = Converter({ from: 'cn', to: 'tw' });
        return converter;
      })
      .catch((e) => {
        loading = null; // 失败可重试
        throw e;
      });
  }
  return loading;
}

/** 界面 zh-TW 时把简体正文转繁体；失败降级返回原文。 */
export async function toTraditional(text) {
  if (getCurrentLocale() !== 'zh-TW') return text;
  try {
    const c = await getConverter();
    return c(text);
  } catch {
    return text; // 降级：不阻塞，输出简体原文
  }
}
```

- [ ] **Step 3: machine.js onResult 接入**

`#openSession` 的 `onResult` 回调（machine.js:152-155）改为异步处理转换：

```js
onResult: (ev) => {
  this.#metrics?.onResult(ev);
  void toTraditional(ev.text).then((text) => {
    this.#emit('vp:asr/partial', { ...ev, text });
  });
},
```

（延迟指标 `#metrics.onResult(ev)` 仍用原始 ev，不因转换异步而污染延迟测量。）

- [ ] **Step 4: selftest 加转换断言**

`app/electron/selftest/i18n.js` 里加：

```js
import { toTraditional } from '../i18n/zh-convert.js';
// runI18nSelftest 内
const tw = await toTraditional('我们在讨论语音输入');
const okZh = tw.includes('我們') && tw.includes('語音');
```

但 selftest 默认 locale 是 en-US，`toTraditional` 会直接返回原文。需要在 selftest 里先 `setCurrentLocale('zh-TW')`（import 自 locale.js），或让 `toTraditional` 接受显式 locale 参数。**选择：`toTraditional(text)` 依赖 getCurrentLocale，selftest 里先 `setCurrentLocale('zh-TW')` 再调。**

- [ ] **Step 5: 跑 selftest**

Run: `cd app && VP_I18N_SELFTEST=1 npx electron .`
Expected: 通过（含繁体转换断言）。

- [ ] **Step 6: Commit**

```bash
git add app/electron/i18n/zh-convert.js app/electron/session/machine.js app/electron/selftest/i18n.js app/package.json app/package-lock.json
git commit -m "feat: zh-TW 下 ASR 正文简→繁（opencc-js）"
```

---

### Task 8: 测试收尾与集成验证

**Files:**
- Modify: `app/src/uitest/run.tsx`（补三语断言）
- Modify: `app/electron/selftest/i18n.js`（如有遗漏补齐）

**Interfaces:**
- Consumes: 全部前序任务产物。

- [ ] **Step 1: uitest 补三语断言**

在 `runUiTest` 的 Studio 部分（约 run.tsx:383 之后），用假 bridge 注入 `getLanguage: () => Promise.resolve({ locale: 'en-US' })`，渲染 `<I18nProvider><Studio .../></I18nProvider>`，断言导航栏出现 "Polish" / "History" / "Settings"。注意 uitest 目前直接 `render(<Studio bridge={studioBridge} />)`，要包 Provider 并给 studioBridge 加 `getLanguage` / `onLanguageChanged`（返回 no-op）两个方法。

- [ ] **Step 2: 跑全部 selftest + uitest**

Run（依次）：
```
cd app && VP_I18N_SELFTEST=1 npx electron .
cd app && VP_STORE_SELFTEST=1 npx electron .
cd app && VP_SM_SELFTEST=1 npx electron .
cd app && VP_POLISH_SELFTEST=1 npx electron .
cd app && VP_UI_SELFTEST=1 npx electron .
cd app && npm run typecheck
```
Expected: 全部通过。

- [ ] **Step 3: 手动验证清单（Windows + macOS）**

1. 设置页切语言 → 主应用 / 悬浮条 / 托盘菜单同步生效（无需重启）。
2. zh-TW 下口述中文 → 正文繁体；润色输出繁体。
3. en-US 界面口述英文 → 润色输出英文。
4. 切换语言后默认场景（last-used）仍正确（按 id 匹配，不因改名失配）。
5. 重启后语言偏好保留（`ui_language` 持久化）。
6. macOS：辅助功能授权引导文案随语言切换（「VoicePilot 聞字」）。

- [ ] **Step 4: Commit（如有改动）**

```bash
git add app/src/uitest/run.tsx app/electron/selftest/i18n.js
git commit -m "test: i18n 三语断言收尾"
```
