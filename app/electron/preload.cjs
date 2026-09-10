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

/** 订阅一个主进程广播，返回取消订阅函数。 */
function subscribe(channel, callback) {
  const handler = (_e, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

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

  // ---------------------------------------------------------------- 听写会话
  //
  // 注意方向：这里只传音频与状态，**不传任何凭据**。API Key 自始至终只在
  // 主进程里（PRD §5.8），渲染进程拿不到，也就不可能泄给页面上的任何脚本。

  /** 触发一次状态转换（五态下语义不同，由主进程状态机决定）。 */
  toggle() {
    return ipcRenderer.invoke('vp:session/toggle');
  },

  /** 拉一次当前状态。渲染进程启动时可能错过了之前的广播。 */
  syncState() {
    return ipcRenderer.invoke('vp:state/sync');
  },

  /** 采集失败上报（麦克风被占用 / 未授权）。只有渲染进程知道原因。 */
  captureFailed(message) {
    ipcRenderer.send('vp:session/capture-failed', message);
  },

  /** 音频帧上行。meta 是 {seq, cumSamples}，pcm 是 Uint8Array。 */
  sendAudio(meta, pcm) {
    ipcRenderer.send('vp:audio/chunk', meta, pcm);
  },

  /** 首帧绘制完成，用于「快捷键 → 上屏」这项延迟。传 epoch 毫秒。 */
  reportPainted(atEpochMs) {
    ipcRenderer.send('vp:ui/painted', atEpochMs);
  },

  /**
   * 复制。返回是否写入成功（主进程会读回剪贴板核对）。
   * 按 2026-09-06 的决定：覆盖剪贴板，不恢复原内容。
   */
  copy(text) {
    return ipcRenderer.invoke('vp:copy', text);
  },

  /** @param cb 收到 (state, notice, truncated) */
  onState(cb) {
    return subscribe('vp:state', cb);
  },

  /** @param cb 收到识别结果事件 */
  onPartial(cb) {
    return subscribe('vp:asr/partial', cb);
  },

  /** @param cb 收到 {kind, message, preserveText} */
  onError(cb) {
    return subscribe('vp:error', cb);
  },

  /** @param cb 收到 {seq, pending}，用于渲染进程侧的背压判断 */
  onAck(cb) {
    return subscribe('vp:audio/ack', cb);
  },

  /** @param cb 会话结束时收到延迟摘要 */
  onMetrics(cb) {
    return subscribe('vp:metrics', cb);
  },

  /** 界面自测跑完回报结果，由主进程决定退出码。 */
  reportUiTestResult(result) {
    ipcRenderer.send('vp:uitest-result', result);
  },

  /**
   * 把采集到的音频落盘为 WAV，返回绝对路径。
   *
   * 必须由主进程代写：渲染进程拿不到 node:fs，也没有权限决定往哪写。
   * 落盘的是 16kHz/16bit/单声道，可直接喂给 `npm run probe -- --audio <路径>`。
   */
  saveWav(bytes) {
    return ipcRenderer.invoke('vp:save-wav', bytes);
  },

  /** 在文件管理器中定位已导出的文件，省得手工找 userData 目录。 */
  revealPath(path) {
    ipcRenderer.send('vp:reveal-path', path);
  },

  /**
   * 退出应用。
   * 托盘图标目前还是空图（见 main.js 的 createTray），点不中菜单里的「退出」，
   * 没有这个口子就只能靠任务管理器杀进程。
   */
  quit() {
    ipcRenderer.send('vp:quit');
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

  /** 请求调整悬浮条窗口高度（内容自适应，主进程有上下限）。 */
  resizeBar(height) {
    ipcRenderer.send('vp:bar/resize', height);
  },

  // ---------------------------------------------------------------- 主应用（Studio）

  /** 打开主应用并带入待润色文本。 */
  openStudio(payload) {
    return ipcRenderer.invoke('vp:studio/open', payload);
  },

  /** 主应用挂载时拉 {text, scenes, tones, defaultSceneId}。 */
  syncStudio() {
    return ipcRenderer.invoke('vp:studio/sync');
  },

  /** 预设列表（kind = scene | tone）。 */
  listPresets(kind) {
    return ipcRenderer.invoke('vp:preset/list', kind);
  },

  /** 新建/编辑预设。 */
  savePreset(payload) {
    return ipcRenderer.invoke('vp:preset/save', payload);
  },

  /** 删除预设（内置不可删，返回 false）。 */
  deletePreset(id) {
    return ipcRenderer.invoke('vp:preset/delete', id);
  },

  /** 关闭主应用窗口。 */
  closeStudio() {
    return ipcRenderer.invoke('vp:studio/close');
  },

  /** 保存一段历史（原文）。返回 {id}。 */
  historySave(payload) {
    return ipcRenderer.invoke('vp:history/save', payload);
  },

  /** 历史列表（倒序）。 */
  historyList() {
    return ipcRenderer.invoke('vp:history/list');
  },

  /** 历史详情。 */
  historyGet(id) {
    return ipcRenderer.invoke('vp:history/get', id);
  },

  /** 采用润色结果，回写历史。 */
  adoptPolish(payload) {
    return ipcRenderer.invoke('vp:polish/adopt', payload);
  },

  /** 发起润色。流式结果经 onPolishDelta/onPolishDone/onPolishError 回传。 */
  startPolish(payload) {
    return ipcRenderer.invoke('vp:polish/start', payload);
  },

  /** @param cb 收到 {text}，润色流式增量，逐块推送 */
  onPolishDelta(cb) {
    return subscribe('vp:polish/delta', cb);
  },

  /** @param cb 润色流结束 */
  onPolishDone(cb) {
    return subscribe('vp:polish/done', cb);
  },

  /** @param cb 收到 {message}，润色失败 */
  onPolishError(cb) {
    return subscribe('vp:polish/error', cb);
  },

  /** 主进程在窗口已存在时推送新文本，编辑器据此刷新。 */
  onStudioRefresh(cb) {
    return subscribe('vp:studio/refresh', cb);
  },

  /** 关闭首次引导窗口。 */
  closeOnboarding() {
    return ipcRenderer.invoke('vp:onboarding/close');
  },

  /** 保存用户输入的 API Key + 工作空间 ID（主进程加密落盘）。 */
  saveKey(payload) {
    return ipcRenderer.invoke('vp:key/save', payload);
  },

  /** 关闭「设置 API Key」窗口。 */
  closeKeyEntry() {
    return ipcRenderer.invoke('vp:key/close');
  },

  // ---------------------------------------------------------------- 权限（F12）

  /** macOS 辅助功能授权状态。非 macOS 返回 {accessibility: null}。 */
  getPermissionStatus() {
    return ipcRenderer.invoke('vp:permission/status');
  },

  /** 打开系统设置 → 辅助功能页（macOS 深链）。 */
  openAccessibilitySettings() {
    return ipcRenderer.invoke('vp:permission/open-settings');
  },

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
});
