# F12 权限引导 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在主应用「设置」页（当前为「待实现」占位）被动显示 macOS 辅助功能授权状态与分步引导，Windows 显示「本平台无需额外权限」。

**Architecture:** 主进程加两个 IPC handler（读 `systemPreferences.isTrustedAccessibilityClient`、深链打开系统设置），经 preload 桥暴露给渲染层；新增 `SettingsView` 组件替换占位，挂载后每 1s 轮询刷新授权状态。

**Tech Stack:** Electron 44（`systemPreferences` / `shell`）、React 19、TypeScript。

## Global Constraints

- **平台守卫**：`isTrustedAccessibilityClient` 是 macOS 独有 API，只在 `process.platform === 'darwin'` 下调用；非 macOS 一律返回 `accessibility: null`（语义 =「不适用」）。
- **检测不弹窗**：轮询调用 `isTrustedAccessibilityClient(false)`，`false` 表示只查不弹，绝不传 `true`（否则每次轮询都弹系统授权框）。
- **复制粘贴文案**：辅助功能勾选对象名必须写 **VoicePilot 闻字**（产品名），不能写成别的。
- **不加 CI 测试**：`isTrustedAccessibilityClient` 是 macOS 独有，Windows/CI 无法运行。自动化门禁用 `npm run typecheck`（`tsc --noEmit`）；行为由真机手工验证。
- **深链 URL**：用经典写法 `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`；macOS 13+ 若失效换 `x-apple.systempreferences:com.apple.settings.privacy?Privacy_Accessibility`（真机验证，见 Task 3）。

---

### Task 1: 主进程权限检测 + IPC + preload 桥 + 类型声明

**Files:**
- Modify: `app/electron/ipc.js:1`（import 行）、`app/electron/ipc.js:247`（`vp:key/close` handler 之后、`return machine` 之前）
- Modify: `app/electron/preload.cjs:246`（`closeKeyEntry` 之后、`});` 之前）
- Modify: `app/src/global.d.ts:112`（`closeKeyEntry` 声明之后、`}` 之前）

**Interfaces:**
- Consumes: 无（纯新增）
- Produces:
  - IPC `vp:permission/status` → `{ accessibility: boolean | null }`
  - IPC `vp:permission/open-settings` → `Promise<boolean>`
  - Bridge `getPermissionStatus(): Promise<{ accessibility: boolean | null }>`
  - Bridge `openAccessibilitySettings(): Promise<boolean>`

- [ ] **Step 1: 改 import 行，引入 systemPreferences**

`app/electron/ipc.js:1`，把：

```js
import { app, clipboard, ipcMain, shell } from 'electron';
```

改成：

```js
import { app, clipboard, ipcMain, shell, systemPreferences } from 'electron';
```

- [ ] **Step 2: 加两个 IPC handler**

`app/electron/ipc.js` 在 `vp:key/close` handler 之后、`return machine;` 之前插入：

```js
  // ---------------------------------------------------------------- 权限（F12）

  /** macOS 辅助功能授权状态。非 macOS 返回 null（表示「不适用」）。 */
  ipcMain.handle('vp:permission/status', () => ({
    accessibility:
      process.platform === 'darwin'
        ? systemPreferences.isTrustedAccessibilityClient(false)
        : null,
  }));

  /**
   * 打开系统设置 → 辅助功能页（macOS 深链）。非 macOS 空操作。
   * URL 用经典写法；macOS 13+ 系统设置改版后若跳转失效，换成
   * 'x-apple.systempreferences:com.apple.settings.privacy?Privacy_Accessibility'
   * （真机验证见 Task 3）。
   */
  ipcMain.handle('vp:permission/open-settings', async () => {
    if (process.platform !== 'darwin') return false;
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
    );
    return true;
  });
```

- [ ] **Step 3: preload 暴露两个方法**

`app/electron/preload.cjs` 在 `closeKeyEntry` 之后、`});` 之前插入：

```js
  // ---------------------------------------------------------------- 权限（F12）

  /** macOS 辅助功能授权状态。非 macOS 返回 {accessibility: null}。 */
  getPermissionStatus() {
    return ipcRenderer.invoke('vp:permission/status');
  },

  /** 打开系统设置 → 辅助功能页（macOS 深链）。 */
  openAccessibilitySettings() {
    return ipcRenderer.invoke('vp:permission/open-settings');
  },
```

- [ ] **Step 4: 类型声明补两个签名**

`app/src/global.d.ts` 在 `closeKeyEntry(): Promise<boolean>;` 之后、`VoicePilotBridge` 接口的闭合 `}` 之前插入：

```ts
  // —— 权限（F12）——
  /** macOS 辅助功能授权状态；非 macOS 为 null（「不适用」） */
  getPermissionStatus(): Promise<{ accessibility: boolean | null }>;
  /** 打开系统设置 → 辅助功能页（macOS 深链） */
  openAccessibilitySettings(): Promise<boolean>;
```

- [ ] **Step 5: 类型检查**

Run: `cd app && npm run typecheck`
Expected: 退出码 0，无报错（此时 `getPermissionStatus` 尚未被任何渲染层调用，属于「已声明未使用」的桥方法，tsc 不报 unused 因为它是接口成员）。

- [ ] **Step 6: Commit**

```bash
git add app/electron/ipc.js app/electron/preload.cjs app/src/global.d.ts
git commit -m "feat(permission): 主进程权限检测 IPC + preload 桥 + 类型声明"
```

---

### Task 2: SettingsView 组件 + 接入 Studio

**Files:**
- Create: `app/src/studio/SettingsView.tsx`
- Modify: `app/src/studio/Studio.tsx:2-4`（import 区）、`app/src/studio/Studio.tsx:43-49`（settings 分支）

**Interfaces:**
- Consumes: `bridge.getPermissionStatus(): Promise<{ accessibility: boolean | null }>`、`bridge.openAccessibilitySettings(): Promise<boolean>`（Task 1 产出）
- Produces: `SettingsView` 组件（`{ bridge }` prop，与 PolishView/HistoryView 同签名）

- [ ] **Step 1: 新建 SettingsView.tsx**

创建 `app/src/studio/SettingsView.tsx`：

```tsx
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

/**
 * 设置页（F12）—— 目前只有「权限」区块：macOS 辅助功能授权状态 + 分步引导。
 * 被动显示：用户遇到快捷键不生效时主动来看，不做弹窗、不做智能触发。
 */

type PermStatus = { accessibility: boolean | null };

export default function SettingsView({ bridge }: { bridge?: Window['voicepilot'] } = {}) {
  const vp = bridge ?? window.voicepilot;
  const [status, setStatus] = useState<PermStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const s = await vp.getPermissionStatus();
        if (alive) setStatus(s);
      } catch {
        // 单次失败保留上次状态，下次轮询自愈
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [vp]);

  // accessibility === null 表示「本平台不适用」（Windows）
  const applicable = status?.accessibility != null;
  const granted = status?.accessibility === true;

  return (
    <div style={styles.page}>
      <h2 style={styles.h2}>权限</h2>

      {!applicable ? (
        <p style={styles.plain}>本平台无需额外权限。</p>
      ) : (
        <div style={styles.block}>
          <div style={styles.statusRow}>
            <span style={styles.label}>辅助功能（全局快捷键）</span>
            <span style={{ ...styles.status, color: granted ? '#16a34a' : '#dc2626' }}>
              {granted ? '已授权 ✓' : '未授权 ✗'}
            </span>
          </div>
          <ol style={styles.steps}>
            <li>打开「系统设置」</li>
            <li>进入「隐私与安全性」</li>
            <li>
              点「辅助功能」，勾选 <b>VoicePilot 闻字</b>
            </li>
          </ol>
          <button style={styles.button} onClick={() => void vp.openAccessibilitySettings()}>
            打开系统设置
          </button>
        </div>
      )}
    </div>
  );
}

const styles = {
  page: { padding: 24, color: '#1f2937', fontSize: 13 },
  h2: { margin: '0 0 16px', fontSize: 15, fontWeight: 600, color: '#111827' },
  plain: { margin: 0, color: '#6b7280' },
  block: { display: 'flex', flexDirection: 'column', gap: 12 },
  statusRow: { display: 'flex', alignItems: 'center', gap: 12 },
  label: { color: '#374151' },
  status: { fontWeight: 600 },
  steps: { margin: 0, paddingLeft: 20, color: '#374151', lineHeight: 1.8 },
  button: {
    alignSelf: 'flex-start',
    padding: '8px 20px',
    borderRadius: 8,
    border: 'none',
    background: '#2563eb',
    color: '#fff',
    fontSize: 13,
    cursor: 'pointer',
  },
} satisfies Record<string, CSSProperties>;
```

- [ ] **Step 2: Studio 引入并渲染 SettingsView**

`app/src/studio/Studio.tsx:2-4`，import 区加一行：

```tsx
import SettingsView from './SettingsView';
```

`app/src/studio/Studio.tsx` 的内容区三元，把最后的分支从占位换成 SettingsView：

```tsx
        {view === 'polish' ? (
          <PolishView bridge={bridge} />
        ) : view === 'history' ? (
          <HistoryView bridge={bridge} />
        ) : (
          <SettingsView bridge={bridge} />
        )}
```

（即删掉原来的 `<div style={styles.placeholder}>待实现</div>`。）

- [ ] **Step 3: 类型检查**

Run: `cd app && npm run typecheck`
Expected: 退出码 0，无报错。

- [ ] **Step 4: Commit**

```bash
git add app/src/studio/SettingsView.tsx app/src/studio/Studio.tsx
git commit -m "feat(permission): 设置页显示辅助功能授权状态与分步引导"
```

---

### Task 3: 真机验证（macOS，手工）

> 本任务无法自动化：`isTrustedAccessibilityClient` 是 macOS 独有 API。需在 Mac 上执行。

**Files:** 无代码改动（仅验证）。

- [ ] **Step 1: 启动并打开设置页**

Run: `cd app && npm start`
操作：点主应用左栏「设置」。

Expected: 权限区块显示，状态为「已授权 ✓ / 未授权 ✗」之一（取决于当前是否已勾选）。

- [ ] **Step 2: 验证状态如实反映授权**

操作：系统设置 → 隐私与安全性 → 辅助功能，把 VoicePilot 闻字（或开发期的 Electron）取消勾选。

Expected: 切回应用，1 秒内状态变「未授权 ✗」。

操作：重新勾选。

Expected: 1 秒内状态变「已授权 ✓」。

- [ ] **Step 3: 验证深链**

操作：点「打开系统设置」。

Expected: 跳转打开到「辅助功能」那一页（不是系统设置首页）。

若跳转失败或只到系统设置首页，说明 URL 需换成 spec §6 备选值 `x-apple.systempreferences:com.apple.settings.privacy?Privacy_Accessibility`，改 `ipc.js` 里的 URL 后重试。

- [ ] **Step 4: 验证 Windows 分支（可在 Windows 机器上做，也可跳过）**

操作：Windows 上 `npm start` → 主应用 → 设置。

Expected: 显示「本平台无需额外权限。」，不显示辅助功能区块。

---

## Self-Review

- **Spec coverage**：spec §1（组件与文件）→ Task 1/2；§2（数据流：1s 轮询 + 深链）→ Task 1（handler）/ Task 2（useEffect 轮询）；§3（UI 文案）→ Task 2；§4（错误处理：平台守卫 + 单次失败自愈）→ Task 1（darwin 守卫）/ Task 2（try/catch）；§5（真机验证，不加 CI）→ Task 3；§6（深链待验证点）→ Task 3 Step 3。
- **Placeholder scan**：无 TBD/TODO；所有代码步骤含完整代码。
- **Type consistency**：`getPermissionStatus` 返回 `Promise<{ accessibility: boolean | null }>`、`openAccessibilitySettings` 返回 `Promise<boolean>`，在 Task 1（preload/global.d.ts）与 Task 2（SettingsView 消费处）一致。
