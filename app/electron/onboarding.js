import { app, BrowserWindow } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setMeta } from './store.js';
import { t } from '../shared/i18n/index.js';
import { getCurrentLocale } from './locale.js';

/**
 * 首次使用欢迎窗口（PRD §4.0 / F8）。只介绍快捷键与权限，不提问。
 * 独立小窗，复用 createDiagWindow 的二级窗口模式，加载 #onboarding 路由。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
let win = null;

export function createOnboardingWindow({ attachDevLogging }) {
  if (process.platform === 'darwin') app.setActivationPolicy('regular');
  if (win && !win.isDestroyed()) {
    win.focus();
    return win;
  }

  win = new BrowserWindow({
    width: 420,
    height: 320,
    resizable: false,
    title: t(getCurrentLocale(), 'window.onboarding'),
    backgroundColor: '#ffffff',
    icon: join(HERE, '..', 'build', 'voicepilot-icon-256.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 语言切换时由 broadcastLocale 据此刷新 OS 标题栏（见 ipc.js）
  win.vpTitleKey = 'window.onboarding';

  attachDevLogging(win);
  win.loadURL('app://voicepilot/index.html#onboarding');
  win.on('closed', () => {
    setMeta('first_run_done', 'true');
    win = null;
    if (process.platform === 'darwin' && !BrowserWindow.getAllWindows().some((w) => w.isFocusable())) {
      app.setActivationPolicy('accessory');
    }
  });
  return win;
}

export function getOnboardingWindow() {
  return win && !win.isDestroyed() ? win : null;
}
