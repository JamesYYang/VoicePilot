import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  screen,
  nativeImage,
  ipcMain,
  protocol,
} from 'electron';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * VoicePilot 主进程。
 *
 * 当前是 M0 阶段的骨架，只负责把三件事跑通：
 *   1. 托盘常驻
 *   2. 全局快捷键
 *   3. 一个不抢焦点的悬浮条窗口
 *
 * 「不抢焦点」是这个程序最硬的约束（PRD §1.2）：从悬浮条出现到消失，
 * 目标应用的光标位置、选区、输入焦点、输入法状态都不得发生任何变化。
 * 实现方式 Windows 与 macOS 完全不同，见 createBar()。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const RENDERER_DIR = resolve(join(ROOT, 'dist', 'renderer'));

// 悬浮条尺寸。PRD §1.2：桌面右下角、半透明、置顶。
const BAR = { width: 560, height: 148, margin: 24 };

let tray = null;
let bar = null;
let rendererReady = false;

// 渲染进程还没加载完时按了快捷键，先记下来，加载完再补发。
let pendingToggle = false;

// ---------------------------------------------------------------- app:// 协议

/**
 * 渲染进程走自定义协议，不用 file://。
 *
 * Chromium 把 file:// 当不透明源，会**静默拒绝**加载 ES module —— 表现是窗口
 * 一片空白且不报错。注册为 secure + standard 的源后，ESM / fetch / Web Audio
 * 全部正常工作。这也是 Electron 官方文档推荐的做法。
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function registerAppProtocol() {
  protocol.handle('app', async (req) => {
    const { pathname } = new URL(req.url);
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    const target = resolve(join(RENDERER_DIR, rel));

    // 目录穿越防护：解析后必须仍在渲染产物目录内，否则拒绝。
    // 没有这道检查的话，页面可以用 app:///../../ 读到用户磁盘上的任意文件。
    if (target !== RENDERER_DIR && !target.startsWith(RENDERER_DIR + sep)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const data = await readFile(target);
      return new Response(data, {
        headers: {
          'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
        },
      });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}

// ---------------------------------------------------------------- 窗口

function createBar() {
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;

  bar = new BrowserWindow({
    width: BAR.width,
    height: BAR.height,
    x: x + width - BAR.width - BAR.margin,
    y: y + height - BAR.height - BAR.margin,

    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,

    // 关键：窗口不可聚焦。这是「不抢焦点」的第一道保证。
    focusable: false,

    webPreferences: {
      // 必须是 .cjs。Electron 的沙箱 preload 一律按 CommonJS 加载，不认
      // package.json 的 "type": "module"，.js 和 .mjs 都会失败并静默白屏。
      // 原因与取舍见 preload.cjs 顶部注释。
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // 悬浮条要持续接收音频与 WS 消息，不能被后台节流
      backgroundThrottling: false,
    },
  });

  if (process.platform === 'darwin') {
    // macOS：出现在所有桌面空间（含全屏应用之上），且不进 Dock。
    // 辅助功能权限未授予时全局快捷键不生效 —— 引导见 PRD §5.7 / F12。
    bar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    app.dock?.hide();
  } else {
    // Windows：screen-saver 级别高于普通 alwaysOnTop，能盖住多数全屏应用。
    // 注意这个 level 在 macOS 上无效，两边必须分开处理。
    bar.setAlwaysOnTop(true, 'screen-saver');
  }

  // 默认鼠标穿透，否则悬浮条会挡住用户正在操作的应用。
  // forward:true 让页面仍收到鼠标移动事件，用于「移入时临时恢复可点击」。
  bar.setIgnoreMouseEvents(true, { forward: true });

  bar.on('close', (e) => {
    e.preventDefault();
    bar.hide(); // 常驻，关闭只隐藏
  });

  if (!app.isPackaged) {
    // 渲染进程里的错误不会出现在主进程 stdout，白屏时完全没有线索。
    // 开发模式把渲染进程的 console 与加载失败转发到终端。
    bar.webContents.on('console-message', (_e, _level, message, _line, sourceId) => {
      console.log(`[渲染] ${message}   ← ${sourceId}`);
    });
    bar.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error(`[加载失败] code=${code} ${desc} ${url}`);
    });
  }

  bar.webContents.once('did-finish-load', () => {
    rendererReady = true;
    if (pendingToggle) {
      pendingToggle = false;
      bar.webContents.send('vp:toggle');
    }
  });

  loadRenderer(bar);
}

/**
 * 加载渲染进程。开发模式可指向 Vite dev server 换取 HMR：
 *   VP_DEV_URL=http://localhost:5173 npm run dev
 */
function loadRenderer(win) {
  const devUrl = process.env.VP_DEV_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadURL('app://voicepilot/index.html');
}

// ---------------------------------------------------------------- 托盘与快捷键

function createTray() {
  // TODO: 需要真实图标资源（Windows .ico / macOS 16x16 模板图）。
  // 空图能撑起托盘菜单，但托盘区看不到图标。
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('VoicePilot 闻字');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示悬浮条', click: () => bar?.show() },
      { label: '隐藏悬浮条', click: () => bar?.hide() },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ])
  );
}

function registerShortcuts() {
  // PRD §4.2：默认 macOS ⌥Space，Windows Ctrl+Shift+Space。
  // Windows 上不能用 Alt+Space（系统菜单）或 Win+Space（输入法切换）。
  const accel = process.platform === 'darwin' ? 'Alt+Space' : 'Ctrl+Shift+Space';

  const ok = globalShortcut.register(accel, () => {
    if (!rendererReady) {
      pendingToggle = true;
      return;
    }
    bar?.webContents.send('vp:toggle');
  });

  if (!ok) {
    // 注册失败几乎都是被别的程序占用了。PRD §4.2 要求设置界面做冲突检测。
    console.error(`[快捷键] ${accel} 注册失败：可能已被其他程序占用`);
  } else {
    console.log(`[快捷键] ${accel} 已注册`);
  }
}

ipcMain.on('vp:renderer-ready', (_e, info) => {
  console.log(`[渲染进程] 已就绪 platform=${info.platform} chrome=${info.chrome}`);
});

ipcMain.on('vp:mouse-passthrough', (_e, passthrough) => {
  bar?.setIgnoreMouseEvents(Boolean(passthrough), { forward: true });
});

// ---------------------------------------------------------------- 生命周期

app.whenReady().then(() => {
  registerAppProtocol();
  createBar();
  createTray();
  registerShortcuts();
  console.log('[VoicePilot] 已启动，托盘常驻');
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// 常驻托盘，所以关掉悬浮条不能导致退出
app.on('window-all-closed', (e) => e.preventDefault());
