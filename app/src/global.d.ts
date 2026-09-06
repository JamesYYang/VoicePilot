/** preload 暴露到 window.voicepilot 的接口。与 electron/preload.cjs 保持一致。 */

interface SessionSnapshot {
  state: 'idle' | 'warming' | 'listening' | 'draining' | 'reviewing';
  notice: { kind: string; message: string; attempt: number; maxAttempts: number } | null;
  truncated: boolean;
}

interface AsrPartial {
  recvAtMs: number;
  text: string;
  sentenceEnd: boolean;
  sentenceId: string | null;
  beginTime: number | null;
  endTime: number | null;
  words: { begin_time: number | null; end_time: number | null; text: string }[];
}

interface VoicePilotBridge {
  platform: string;
  versions: { electron: string; chrome: string; node: string };

  // —— 听写会话 ——
  /** 触发一次状态转换，返回最新状态 */
  toggle(): Promise<SessionSnapshot>;
  /** 拉一次当前状态（渲染进程启动时可能错过了广播） */
  syncState(): Promise<SessionSnapshot>;
  /** 采集失败上报：只有渲染进程知道 getUserMedia 为什么失败 */
  captureFailed(message: string): void;
  /** 音频帧上行。meta = {seq, cumSamples}，pcm 是原始字节 */
  sendAudio(meta: { seq: number; cumSamples: number }, pcm: Uint8Array): void;
  /** 首帧绘制完成（epoch ms），用于「快捷键 → 上屏」延迟 */
  reportPainted(atEpochMs: number): void;
  /** 写入剪贴板，返回是否成功。覆盖，不恢复原内容 */
  copy(text: string): Promise<boolean>;
  onState(cb: (s: SessionSnapshot) => void): () => void;
  onPartial(cb: (p: AsrPartial) => void): () => void;
  onError(cb: (e: { kind: string; message: string; preserveText: boolean }) => void): () => void;
  /** {seq, pending}：seq 之前（含）的帧已被主进程取走 */
  onAck(cb: (a: { seq: number; pending: number }) => void): () => void;
  onMetrics(cb: (m: Record<string, unknown>) => void): () => void;
  /** 界面自测回报结果，主进程据此决定退出码 */
  reportUiTestResult(r: { ok: boolean; failed: number; total: number }): void;

  // —— 通用 ——
  /** 全局快捷键被按下时回调，返回取消订阅函数 */
  onToggle(callback: () => void): () => void;
  /** 切换鼠标穿透：悬浮条默认穿透，鼠标移入时要临时关闭才能点按钮 */
  setMousePassthrough(passthrough: boolean): void;
  /** 把 WAV 字节落盘，返回绝对路径（M1 采集诊断用） */
  saveWav(bytes: Uint8Array): Promise<string>;
  /** 在文件管理器中定位文件 */
  revealPath(path: string): void;
  /** 退出应用（托盘图标目前是空图，点不到菜单里的退出） */
  quit(): void;

  // —— 主应用（Studio）——
  /** 打开主应用并带入待润色文本 */
  openStudio(text: string): Promise<boolean>;
  /** 主应用挂载时拉 {text, scenes, tones} */
  syncStudio(): Promise<{ text: string; scenes: string[]; tones: string[] }>;
  /** 发起润色（Task 5 接流式；本任务 stub） */
  startPolish(payload: { text: string; scene: string; tone: string }): Promise<void>;
}

interface Window {
  voicepilot: VoicePilotBridge;
}
