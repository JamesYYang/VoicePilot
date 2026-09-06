import { app, clipboard, ipcMain, shell } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionMachine } from './session/machine.js';
import { createStudioWindow, getStudioWindow } from './studio.js';
import { SCENES, TONES } from './llm/prompt.js';

/**
 * 所有 IPC 的注册点。main.js 只管应用外壳（窗口、托盘、快捷键、生命周期），
 * 业务通道集中在这里，免得主进程文件越滚越长。
 *
 * ⚠️ 方向性是有讲究的：API Key 只出现在主进程，渲染进程**只能**拿到音频与状态，
 * 拿不到任何凭据（PRD §5.8）。所以这里绝不能出现把 creds 发回去的通道。
 */
/**
 * 打开主应用时带过去的待润色文本。悬浮条每次点「润色」都会覆盖它，
 * 主应用挂载时经 vp:studio/sync 拉走。
 */
let pendingStudioText = '';

export function registerIpc({ getBar, requestQuit, attachDevLogging }) {
  /**
   * 主进程 → 渲染进程。
   * 悬浮条可能还没加载完，也可能已被关闭，发送前必须检查。
   */
  const emit = (channel, payload) => {
    const bar = getBar();
    if (bar && !bar.isDestroyed()) bar.webContents.send(channel, payload);
  };

  const machine = new SessionMachine({ emit });

  // ---------------------------------------------------------------- 会话

  /** 快捷键与界面按钮共用：五态下语义不同，由状态机决定。 */
  ipcMain.handle('vp:session/toggle', async () => {
    await machine.toggle();
    return machine.getSnapshot();
  });

  /** 渲染进程挂载时拉一次当前状态，避免错过它启动前广播的那几次。 */
  ipcMain.handle('vp:state/sync', () => machine.getSnapshot());

  /**
   * 采集失败（最常见是麦克风被占用或没有授权）。
   * 必须由渲染进程上报 —— 它才知道 getUserMedia 为什么失败。
   * 收敛到 idle 并给出明确提示，符合 A7。
   */
  ipcMain.on('vp:session/capture-failed', (_e, message) => {
    machine.abortByCaptureError(message);
  });

  /** 音频帧上行。传 Uint8Array，不要转普通数组或 JSON（会放大 3–5 倍）。 */
  ipcMain.on('vp:audio/chunk', (_e, meta, pcm) => {
    machine.onAudioFrame(meta, pcm);
  });

  /** 渲染进程首帧绘制完成（epoch ms），用于「快捷键 → 上屏」这项延迟。 */
  ipcMain.on('vp:ui/painted', (_e, atEpochMs) => {
    machine.markPainted(atEpochMs);
  });

  /**
   * 复制。按 2026-09-06 的决定：**覆盖剪贴板，不恢复原内容**
   * （与 PRD F3 / A6 原文不同，PRD 需同步修改）。
   */
  ipcMain.handle('vp:copy', async (_e, text) => {
    const t = String(text ?? '');
    try {
      // ⚠️ Electron 44 的 clipboard API 是**异步**的：writeText / readText
      // 都返回 Promise。同步写法（不 await）会写出个寂寞，而且把 Promise
      // 当字符串比较永远为 false —— 表现是「点了复制，什么都没发生」。
      await clipboard.writeText(t);
      const back = await clipboard.readText();
      return back === t;
    } catch (e) {
      // 剪贴板被占用是常态（别的程序正开着它），抛出去只会让渲染进程
      // 拿到一个 rejection。这里吞掉并返回 false，由界面提示用户重试。
      console.warn(`[复制] 写入失败：${e?.message ?? e}`);
      return false;
    }
  });

  // ---------------------------------------------------------------- 通用

  /**
   * 把采集的 WAV 写到 userData/captures 下。
   * 不走保存对话框：spike 阶段要反复导出，每次选路径纯属折磨。
   */
  ipcMain.handle('vp:save-wav', async (_e, bytes) => {
    const dir = join(app.getPath('userData'), 'captures');
    await mkdir(dir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(dir, `capture-${stamp}.wav`);
    await writeFile(file, Buffer.from(bytes));
    console.log(`[采集] 已导出 ${file}（${(bytes.length / 1024 / 1024).toFixed(2)} MB）`);
    return file;
  });

  ipcMain.on('vp:reveal-path', (_e, path) => {
    shell.showItemInFolder(path);
  });

  ipcMain.on('vp:quit', () => requestQuit());

  /** 界面自测跑完：把成败变成进程退出码，便于脚本/CI 判断。 */
  ipcMain.on('vp:uitest-result', (_e, r) => {
    console.log(`[界面自测] ${r.ok ? '全部通过' : `失败 ${r.failed}/${r.total} 项`}`);
    requestQuit(r.ok ? 0 : 1);
  });

  // ---------------------------------------------------------------- 悬浮条

  ipcMain.on('vp:renderer-ready', (_e, info) => {
    console.log(`[渲染进程] 已就绪 platform=${info.platform} chrome=${info.chrome}`);
  });

  /**
   * 切换鼠标穿透。
   * 悬浮条默认穿透（否则挡住用户正在操作的应用），鼠标移入时临时关闭，
   * 否则「复制」「润色」两个按钮点不到。见 PRD §5.6。
   */
  ipcMain.on('vp:mouse-passthrough', (_e, passthrough) => {
    const bar = getBar();
    bar?.setIgnoreMouseEvents(Boolean(passthrough), { forward: true });
  });

  // ---------------------------------------------------------------- 主应用（Studio）

  /** 打开主应用，把悬浮条刚转出来的文本带过去。 */
  ipcMain.handle('vp:studio/open', (_e, text) => {
    pendingStudioText = String(text ?? '');
    createStudioWindow({ attachDevLogging });
    // 窗口已存在时只 focus 不重载，所以这里主动推一次刷新事件，
    // 让已挂载的编辑器用新文本覆盖旧内容（重复口述→再点润色的场景）。
    // 对刚创建的窗口发也没关系：渲染进程还没订阅时这条会被丢掉，
    // 挂载时的 syncStudio() 会兜住「首次打开」这一路。
    const win = getStudioWindow();
    if (win) win.webContents.send('vp:studio/refresh', { text: pendingStudioText });
    return true;
  });

  /** 主应用挂载时拉一次：待润色文本 + 场景/语气选项。 */
  ipcMain.handle('vp:studio/sync', () => ({
    text: pendingStudioText,
    scenes: SCENES,
    tones: TONES,
  }));

  /**
   * 润色入口。Task 5 接入真正的流式润色；本任务先 stub，保证界面点
   * 「润色」有处可调、链路能通。
   */
  ipcMain.handle('vp:polish/start', async () => {});

  return machine;
}
