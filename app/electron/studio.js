import { app, BrowserWindow } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from '../shared/i18n/index.js';
import { getCurrentLocale } from './locale.js';

/**
 * 主应用（Studio）窗口 —— 润色工作区的宿主。
 *
 * 与悬浮条（createBar）不同：这是一个普通的、可聚焦的窗口。用户点开它是要
 * 认真地编辑/润色文本，不涉及「不抢焦点」那条硬约束（A2 只管悬浮条）。
 *
 * 亮色背景（spec §2）：与悬浮条的暗色浮层做视觉区分，也是桌面应用里
 * 编辑区的常规形态。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
let studioWin = null;

export function createStudioWindow({ attachDevLogging }) {
  if (process.platform === 'darwin') app.setActivationPolicy('regular');
  if (studioWin && !studioWin.isDestroyed()) {
    studioWin.focus();
    return studioWin;
  }

  studioWin = new BrowserWindow({
    width: 960,
    height: 700,
    minWidth: 720,
    minHeight: 480,
    title: t(getCurrentLocale(), 'window.studio'),
    backgroundColor: '#ffffff', // 亮色（spec §2）
    icon: join(HERE, '..', 'build', 'voicepilot-icon-256.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 语言切换时由 broadcastLocale 据此刷新 OS 标题栏（见 ipc.js）
  studioWin.vpTitleKey = 'window.studio';

  attachDevLogging(studioWin);
  studioWin.loadURL('app://voicepilot/index.html#studio');
  studioWin.on('closed', () => {
    studioWin = null;
    if (process.platform === 'darwin' && !BrowserWindow.getAllWindows().some((w) => w.isFocusable())) {
      app.setActivationPolicy('accessory');
    }
  });
  return studioWin;
}

export function getStudioWindow() {
  return studioWin && !studioWin.isDestroyed() ? studioWin : null;
}
