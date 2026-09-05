const { contextBridge, ipcRenderer } = require('electron');

/**
 * 渲染进程与主进程之间唯一的桥。
 *
 * 严格遵循 PRD §5.8：API Key 等敏感信息只在主进程持有，这里绝不暴露。
 * 对外只给渲染进程必要的、最小的一组能力。
 *
 * ⚠️ 这个文件必须是 CommonJS，不能改成 ESM。
 *
 * Electron 的沙箱 preload 一律按 CommonJS 加载 —— 即便 package.json 里写了
 * "type": "module"，也不认 .js，改成 .mjs 同样失败，报：
 *   SyntaxError: Cannot use import statement outside a module
 * 而失败是静默的：preload 没跑 → window.voicepilot 是 undefined → 页面白屏，
 * 主进程日志里只有一句 "Unable to load preload script"，极易漏掉。
 *
 * 另一个选项是把 webPreferences.sandbox 设为 false 来换取 ESM 支持，但那是
 * 安全降级，不值得 —— 这里只有几十行胶水代码，用 CJS 没有损失。
 */

// 渲染进程一加载就回报一次。主进程据此确认「协议 → HTML → JS → preload → IPC」
// 整条链路真的通了 —— 页面白屏时这条日志不会出现，比肉眼看窗口可靠。
ipcRenderer.send('vp:renderer-ready', {
  platform: process.platform,
  chrome: process.versions.chrome,
});

contextBridge.exposeInMainWorld('voicepilot', {
  platform: process.platform,

  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },

  /** 全局快捷键被按下时回调。返回取消订阅函数。 */
  onToggle(callback) {
    const handler = () => callback();
    ipcRenderer.on('vp:toggle', handler);
    return () => ipcRenderer.removeListener('vp:toggle', handler);
  },

  /**
   * 切换鼠标穿透。
   *
   * 悬浮条默认穿透（否则会挡住用户正在操作的应用），鼠标移入时要临时
   * 关闭穿透，否则「复制」「润色」两个按钮点不到。见 PRD §5.6。
   */
  setMousePassthrough(passthrough) {
    ipcRenderer.send('vp:mouse-passthrough', Boolean(passthrough));
  },
});
