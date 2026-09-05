/** preload 暴露到 window.voicepilot 的接口。与 electron/preload.js 保持一致。 */
interface VoicePilotBridge {
  platform: string;
  versions: { electron: string; chrome: string; node: string };
  /** 全局快捷键被按下时回调，返回取消订阅函数 */
  onToggle(callback: () => void): () => void;
  /** 切换鼠标穿透：悬浮条默认穿透，鼠标移入时要临时关闭才能点按钮 */
  setMousePassthrough(passthrough: boolean): void;
}

interface Window {
  voicepilot: VoicePilotBridge;
}
