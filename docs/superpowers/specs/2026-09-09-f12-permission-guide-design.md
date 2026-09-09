# F12 权限引导设计（设置页被动显示 macOS 辅助功能授权）

- **日期**: 2026-09-09
- **状态**: 待评审
- **上游**: `docs/plans/2026-09-05-voicepilot-prd.md`（PRD §5.7）
- **范围**: 在主应用「设置」页（当前为「待实现」占位）被动显示 macOS 辅助功能权限状态与分步引导。不做首次启动弹窗、不做智能触发。

## 0. 已拍板的关键决策

| 决策 | 结论 | 依据 |
|---|---|---|
| 触发时机 | **只在设置页被动显示**，不强制弹窗、不智能触发 | 用户拍板 |
| 检测对象 | **只做辅助功能权限**（macOS 独有，全局快捷键依赖）；麦克风由系统首次采集时自行弹窗、拒绝后有 A7 兜底，不在 F12 范围 | PRD §5.7 |
| 平台差异 | 设置页共享；权限区块按平台显示——macOS 显示状态+引导，Windows 显示「本平台无需额外权限」 | 主应用（Studio）双平台共用一套代码 |
| 打开系统设置 | **深链** `shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')`，不用系统弹窗 | 系统弹窗话术不可控、不能直跳目标页 |
| 图文 | **文字编号步骤**，不塞截图 | 截图需跟 macOS 版本维护，50 人内测不值；必要时后补 |

## 1. 组件与文件

**新增**
- `app/src/studio/SettingsView.tsx` — 设置页组件（替换「待实现」占位）

**修改**

| 文件 | 改动 |
|---|---|
| `app/electron/ipc.js` | 加 `vp:permission/status` handler（返回 `{ accessibility: boolean \| null }`）+ `vp:permission/open-settings` handler（macOS 深链，非 mac 空操作） |
| `app/electron/preload.cjs` | 加 `getPermissionStatus()` / `openAccessibilitySettings()` |
| `app/src/global.d.ts` | `VoicePilotBridge` 补两个方法签名 |
| `app/src/studio/Studio.tsx` | settings 分支渲染 `<SettingsView bridge={bridge} />` |

## 2. 数据流

```
SettingsView 挂载
  → bridge.getPermissionStatus() 拉一次
  → useEffect setInterval 每 1s 重拉（实时反映授权状态）
  → 卸载 clearInterval（切到润色/历史即停，不空转）

用户点「打开系统设置」
  → bridge.openAccessibilitySettings()
  → ipc.js: shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
```

- 检测 API：`systemPreferences.isTrustedAccessibilityClient(false)`（只查不弹），**只在 `process.platform === 'darwin'` 下调用**。
- 非 mac 平台：`accessibility` 返回 `null`，UI 走「无需额外权限」分支。
- 轮询 1s 仅在 SettingsView 挂载期间运行，成本可忽略（一次 IPC 布尔查询）。

## 3. UI

**macOS — 「权限」区块：**

- 辅助功能状态行：`已授权 ✓`（绿）/ `未授权 ✗`（红）
- 3 步文字引导：
  1. 打开「系统设置」
  2. 进入「隐私与安全性」
  3. 点「辅助功能」，勾选 **VoicePilot 闻字**
- 「打开系统设置」按钮（深链直跳辅助功能页）

**Windows — 显示一行「本平台无需额外权限」。**

## 4. 错误处理

- 平台守卫：`isTrustedAccessibilityClient` 仅 darwin 调用；非 mac 直接返回 `null`。
- `openExternal` 失败（理论上不抛）：catch 后静默忽略，用户仍可手动走文字步骤。
- 轮询中单次 IPC 失败：不清空上次状态，显示保持，下次轮询自愈。

## 5. 测试

- **组件可注入**：`SettingsView` 走现有 `bridge` 注入模式（与 PolishView/HistoryView 一致），可注入假 `getPermissionStatus` 渲染两种状态。
- **真机验证（macOS 上手工）**：
  1. 设置页状态如实反映授权（勾掉 → 变红，勾上 → 变绿）
  2. 「打开系统设置」深链打开到辅助功能页
- **不加 CI 测试**：`isTrustedAccessibilityClient` 是 macOS 独有 API，Windows/CI 环境无法运行。

## 6. 待验证点（代码中留注释）

深链 URL 用经典写法 `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`。macOS 13+ 系统设置改版后可能需改为 `x-apple.systempreferences:com.apple.settings.privacy?Privacy_Accessibility`。须在真机点一次确认，实现时在该行留注释标记。
