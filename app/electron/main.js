import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  screen,
  nativeImage,
  protocol,
} from 'electron';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import './tls-ca.js';
import { registerIpc } from './ipc.js';
import { createStudioWindow } from './studio.js';
import { createOnboardingWindow } from './onboarding.js';
import { createKeyEntryWindow } from './key-entry.js';
import { hasCredentials } from './asr/config.js';
import { getMeta } from './store.js';
import { t } from '../shared/i18n/index.js';
import { getCurrentLocale } from './locale.js';

/**
 * VoicePilot 主进程 —— 应用外壳。
 *
 * 只负责四件事：托盘常驻、全局快捷键、不抢焦点的悬浮条窗口、app:// 协议。
 * 听写业务（ASR 会话、状态机、音频队列、埋点）在 ipc.js 及其下游模块里，
 * 那些才是主进程的重心。
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
// 长文本时悬浮条自动长高的上限。避免一句说太长把窗口拉得变形。
const BAR_MAX_HEIGHT = 420;

let tray = null;
let bar = null;
let diag = null;

/**
 * 是否正在走退出流程。
 *
 * 这个标志是必需的，因为 app.quit() 的语义是「先尝试关闭所有窗口，全都关掉了
 * 才真的退出」。而下面两处为了「常驻托盘」会无条件拦住关闭：
 *   - 悬浮条的 close：preventDefault 后 hide（点叉只是隐藏，不该退出）
 *   - window-all-closed：防止关掉最后一个窗口就退出
 * 于是不管是托盘菜单的「退出」还是界面上的退出按钮，调 app.quit() 都会被自己
 * 拦下来，表现是「点了退出，应用还活着」。
 *
 * 所以退出必须显式发起：置上这个标志，让上面两处放行。
 */
let isQuitting = false;

function requestQuit(exitCode = 0) {
  isQuitting = true;
  // 自测这类无人值守的场景要把成败传给调用方（脚本 / CI），而 app.quit()
  // 不携带退出码，只能走 app.exit()。正常退出仍走 app.quit() 的干净流程。
  if (exitCode !== 0) {
    app.exit(exitCode);
    return;
  }
  app.quit();
}


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

/**
 * 把渲染进程的 console 与加载失败转发到终端。
 *
 * 每个窗口都要挂。渲染进程里的报错不会出现在主进程 stdout，不挂就只剩
 * 一片白屏毫无线索 —— M1 采集诊断的读数也是靠 console 打出来的，
 * 漏挂一个窗口等于这次测量白跑。
 */
function attachDevLogging(win) {
  if (app.isPackaged) return;
  win.webContents.on('console-message', (_e, _level, message, _line, sourceId) => {
    console.log(`[渲染] ${message}   ← ${sourceId}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[加载失败] code=${code} ${desc} ${url}`);
  });
}

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
    show: false,
    fullscreenable: false,
    hiddenInMissionControl: true,
    acceptFirstMouse: true,

    // 关键：窗口不可聚焦。这是「不抢焦点」的第一道保证。
    focusable: false,
    // macOS：NSPanel + Nonactivating，否则快捷键会把本应用激活，前台输入框丢焦点。
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),

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
    // macOS：出现在所有桌面空间（含全屏应用之上）。不进 Dock 靠 accessory 策略。
    // 辅助功能权限未授予时全局快捷键不生效 —— 引导见 PRD §5.7 / F12。
    bar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } else {
    // Windows：screen-saver 级别高于普通 alwaysOnTop，能盖住多数全屏应用。
    // 注意这个 level 在 macOS 上无效，两边必须分开处理。
    bar.setAlwaysOnTop(true, 'screen-saver');
  }

  // 默认鼠标穿透，否则悬浮条会挡住用户正在操作的应用。
  // forward:true 让页面仍收到鼠标移动事件，用于「移入时临时恢复可点击」。
  bar.setIgnoreMouseEvents(true, { forward: true });

  bar.on('close', (e) => {
    if (isQuitting) return; // 真要退出时放行，否则 app.quit() 会被这里拦死
    e.preventDefault();
    bar.hide(); // 常驻，关闭只隐藏
  });

  attachDevLogging(bar);

  bar.once('ready-to-show', () => bar.showInactive());
  loadRenderer(bar);
}

/**
 * 按渲染进程报上来的内容高度调整悬浮条窗口高度。
 *
 * 只在 [BAR.height, BAR_MAX_HEIGHT] 区间内变，且不超出工作区；保持底边不动
 * （向上生长），这样悬浮条始终贴着桌面右下角，不会越说越往上漂。
 */
function resizeBar(height) {
  if (!bar || bar.isDestroyed()) return;

  const { height: workH } = screen.getPrimaryDisplay().workArea;
  const max = Math.min(BAR_MAX_HEIGHT, workH - BAR.margin * 2);
  const clamped = Math.min(Math.max(Math.round(height), BAR.height), max);

  const b = bar.getBounds();
  if (Math.abs(b.height - clamped) < 1) return; // 没变化就跳过，避免高频抖动

  const bottom = b.y + b.height; // 底边固定
  bar.setBounds({ x: b.x, y: bottom - clamped, width: b.width, height: clamped });
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

// ---------------------------------------------------------------- 采集诊断窗口

/**
 * M1 采集 spike 的诊断窗口（PRD §5.2 第 6 条）。
 *
 * 必须是独立窗口，不能复用悬浮条：悬浮条 focusable:false 且默认鼠标穿透，
 * 里面的按钮根本点不到，而诊断面板需要点「开始采集」。
 *
 * 这是开发工具，不在 PRD 的交付范围内 —— 但它同时是 F13 诊断导出的雏形，
 * 所以保留在主应用里，而不是另起一个 spike 工程。
 */
function createDiagWindow() {
  if (process.platform === 'darwin') app.setActivationPolicy('regular');
  if (diag && !diag.isDestroyed()) {
    diag.focus();
    return;
  }

  diag = new BrowserWindow({
    width: 920,
    height: 780,
    title: t(getCurrentLocale(), 'window.diag'),
    icon: join(HERE, '..', 'build', 'voicepilot-icon-256.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // 采集过程中窗口被切到后台，也要继续收音频：后台节流会直接毁掉测量
      backgroundThrottling: false,
    },
  });
  // 语言切换时由 broadcastLocale 据此刷新 OS 标题栏（见 ipc.js）
  diag.vpTitleKey = 'window.diag';

  // VP_OPEN_DIAG 给纯数字时当作自动采集时长（毫秒），跑完自动停并导出。
  const autorun = Number(process.env.VP_OPEN_DIAG);
  const hash =
    Number.isFinite(autorun) && autorun > 1 ? `#diag?autorun=${autorun}` : '#diag';
  attachDevLogging(diag);
  diag.loadURL(`app://voicepilot/index.html${hash}`);
  diag.on('closed', () => {
    diag = null;
    if (process.platform === 'darwin' && !BrowserWindow.getAllWindows().some((w) => w.isFocusable())) {
      app.setActivationPolicy('accessory');
    }
  });
}

/**
 * 界面自测用的隐藏窗口。
 * show:false —— 断言读的是 DOM 的 textContent，点击也是程序化的，
 * 都不需要真的把窗口显示出来；不显示还能避免测试时窗口乱闪。
 */
function createUiTestWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  attachDevLogging(win);
  win.loadURL('app://voicepilot/index.html#uitest');
  return win;
}

// ---------------------------------------------------------------- 托盘与快捷键

/**
 * 用当前 locale 重建托盘的 tooltip 与菜单。
 *
 * 菜单模板集中在这里，方便语言切换时整体刷新（Task 2 的 setCurrentLocale
 * 通过 registerIpc 传进来的 rebuildTray 回调触发）。工具提示与菜单 label
 * 都走 t()，只有图标留在 createTray 里（图标不随语言变）。
 */
function rebuildTray() {
  if (!tray || tray.isDestroyed()) return;
  const locale = getCurrentLocale();
  tray.setToolTip(t(locale, 'productName'));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t(locale, 'tray.openMain'), click: () => createStudioWindow({ attachDevLogging }) },
      { type: 'separator' },
      { label: t(locale, 'tray.diag'), click: () => createDiagWindow() },
      { type: 'separator' },
      { label: t(locale, 'tray.setKey'), click: () => createKeyEntryWindow({ attachDevLogging }) },
      { type: 'separator' },
      { label: t(locale, 'tray.quit'), click: () => requestQuit() },
    ])
  );
}

function loadTrayImage() {
  // Windows 托盘吃 .ico；macOS 菜单栏不认 .ico，空图就等于没托盘。
  const file = process.platform === 'darwin' ? 'voicepilot-icon-56.png' : 'voicepilot-icon.ico';
  const p = join(HERE, '..', 'build', file);
  let img = nativeImage.createFromPath(p);
  if (img.isEmpty()) {
    try {
      img = nativeImage.createFromBuffer(readFileSync(p));
    } catch {
      img = nativeImage.createEmpty();
    }
  }
  // 菜单栏约 18pt。56px 原图不缩放会被裁成一角，看起来像撑满却只露一小块。
  if (process.platform === 'darwin' && !img.isEmpty()) {
    const trayIcon = nativeImage.createEmpty();
    trayIcon.addRepresentation({
      scaleFactor: 1,
      width: 18,
      height: 18,
      buffer: img.resize({ width: 18, height: 18 }).toPNG(),
    });
    trayIcon.addRepresentation({
      scaleFactor: 2,
      width: 36,
      height: 36,
      buffer: img.resize({ width: 36, height: 36 }).toPNG(),
    });
    return trayIcon;
  }
  return img;
}

function createTray() {
  tray = new Tray(loadTrayImage());
  rebuildTray();
}

function registerShortcuts(machine) {
  // PRD §4.2：默认 macOS ⌥Space，Windows Ctrl+Shift+Space。
  // Windows 上不能用 Alt+Space（系统菜单）或 Win+Space（输入法切换）。
  const accel = process.platform === 'darwin' ? 'Alt+Space' : 'Ctrl+Shift+Space';

  const ok = globalShortcut.register(accel, () => {
    // 直接驱动状态机，不再经渲染进程转发：
    // 状态只有一个源头（主进程），渲染进程只负责显示，避免两边状态打架。
    void machine.toggle();
  });

  if (!ok) {
    // 注册失败几乎都是被别的程序占用了。PRD §4.2 要求设置界面做冲突检测。
    console.error(`[快捷键] ${accel} 注册失败：可能已被其他程序占用`);
  } else {
    console.log(`[快捷键] ${accel} 已注册`);
  }
}


// ---------------------------------------------------------------- 生命周期

app.whenReady().then(async () => {
  // 离线自测：不建任何窗口，跑完就退出。这样它能在无人值守的机器上跑，
  // 并且验的就是主进程的真实路径（含 config.js 的 app.isPackaged 守卫）。
  // 协议与 IPC 必须先注册：自测窗口也走 app:// 协议，也要用到 vp:copy 等通道。
  // 注册动作本身没有副作用，放在分支之前最省心。
  registerAppProtocol();
  const machine = registerIpc({ getBar: () => bar, requestQuit, attachDevLogging, resizeBar, rebuildTray });

  // 前两个自测都是「不建窗口、跑完就退」，可以在无人值守的机器上跑，
  // 验的也都是主进程的真实路径。
  const selftest = process.env.VP_ASR_SELFTEST
    ? './selftest/asr.js'
    : process.env.VP_SM_SELFTEST
      ? './selftest/machine.js'
      : process.env.VP_POLISH_SELFTEST
        ? './selftest/polish.js'
        : process.env.VP_STORE_SELFTEST
          ? './selftest/store.js'
          : process.env.VP_I18N_SELFTEST
            ? './selftest/i18n.js'
            : null;

  // 界面自测需要一个隐藏窗口来渲染，结果由 vp:uitest-result 回报（见 ipc.js）
  if (process.env.VP_UI_SELFTEST) {
    createUiTestWindow();
    return;
  }

  if (selftest) {
    const mod = await import(selftest);
    const run = mod.runAsrSelftest ?? mod.runMachineSelftest ?? mod.runPolishSelftest ?? mod.runStoreSelftest ?? mod.runI18nSelftest;
    try {
      const r = await run();
      requestQuit(r.ok ? 0 : 1);
    } catch (e) {
      console.error(`[自测] 异常终止：${e?.stack ?? e}`);
      requestQuit(1);
    }
    return;
  }

  createBar();
  createTray();
  registerShortcuts(machine);

  // 无 API Key 时弹输入窗（打包版没有 .env，靠这里拿 Key；开发期有 .env 则不会弹）。
  // 将来 F11 配置端点落地后，hasCredentials 会因端点下发而为 true，此窗自然不再出现。
  const needKey = !hasCredentials();
  const needOnboard = getMeta('first_run_done') !== 'true';
  if (process.platform === 'darwin') {
    // accessory：快捷键/托盘不把本应用变成前台，焦点留在用户正在打字的程序。
    app.setActivationPolicy(needKey || needOnboard ? 'regular' : 'accessory');
  }
  if (needKey) {
    createKeyEntryWindow({ attachDevLogging });
  }

  // 首次启动引导窗（F8）—— 欢迎页：快捷键 + 权限提示。首次启动弹一次，之后不再弹。
  if (needOnboard) {
    createOnboardingWindow({ attachDevLogging });
  }

  // 开发时用 VP_OPEN_DIAG=1 直接把诊断窗口开出来。
  // 给毫秒数则自动跑一轮：VP_OPEN_DIAG=180000 采集 3 分钟后自动停止并导出。
  if (process.env.VP_OPEN_DIAG) createDiagWindow();

  console.log('[VoicePilot] 已启动，托盘常驻');
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// 常驻托盘，所以关掉悬浮条不能导致退出。
// 但主动退出时要放行：订阅了这个事件就等于接管了「是否退出」的决定，
// 无条件 preventDefault 会让 app.quit() 永远退不掉。
app.on('window-all-closed', (e) => {
  if (isQuitting) return;
  e.preventDefault();
});
