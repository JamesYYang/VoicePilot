import { BrowserWindow } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 「设置 API Key」窗口。
 *
 * 启动时发现没有可用凭据（无 .env、无持久化 store）时弹出，让用户填入
 * API Key + 工作空间 ID。Key 只经 IPC 送到主进程、由主进程用 safeStorage
 * 加密落盘，渲染进程拿到的是两个输入框的值，不接触任何持久化逻辑。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
let win = null;

export function createKeyEntryWindow({ attachDevLogging }) {
  if (win && !win.isDestroyed()) {
    win.focus();
    return win;
  }

  win = new BrowserWindow({
    width: 440,
    height: 380,
    resizable: false,
    title: '设置 API Key — VoicePilot 闻字',
    backgroundColor: '#ffffff',
    icon: join(HERE, '..', 'build', 'voicepilot-icon-256.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  attachDevLogging(win);
  win.loadURL('app://voicepilot/index.html#key-entry');
  win.on('closed', () => {
    win = null;
  });
  return win;
}

export function getKeyEntryWindow() {
  return win && !win.isDestroyed() ? win : null;
}
