import { app, clipboard, ipcMain, shell } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionMachine } from './session/machine.js';
import { createStudioWindow, getStudioWindow } from './studio.js';
import { getOnboardingWindow } from './onboarding.js';
import { listPresets, savePreset, deletePreset, getMeta, setMeta, saveHistory, listHistory, getHistory, updateHistoryPolish } from './store.js';
import { streamPolish } from './llm/polish.js';

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
let pendingHistoryId = null;

export function registerIpc({ getBar, requestQuit, attachDevLogging, resizeBar }) {
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

  /** 渲染进程报内容高度，请求调整悬浮条窗口高度（向上生长，有上限）。 */
  ipcMain.on('vp:bar/resize', (_e, height) => {
    resizeBar(Number(height));
  });

  // ---------------------------------------------------------------- 主应用（Studio）

  /** 打开主应用，把悬浮条刚转出来的文本带过去。 */
  ipcMain.handle('vp:studio/open', (_e, { text, historyId }) => {
    pendingStudioText = String(text ?? '');
    pendingHistoryId = historyId != null ? Number(historyId) : null;
    createStudioWindow({ attachDevLogging });
    // 窗口已存在时只 focus 不重载，所以这里主动推一次刷新事件，
    // 让已挂载的编辑器用新文本覆盖旧内容（重复口述→再点润色的场景）。
    // 对刚创建的窗口发也没关系：渲染进程还没订阅时这条会被丢掉，
    // 挂载时的 syncStudio() 会兜住「首次打开」这一路。
    const win = getStudioWindow();
    if (win) win.webContents.send('vp:studio/refresh', { text: pendingStudioText });
    return true;
  });

  /** 主应用挂载时拉一次：待润色文本 + 场景/语气预设（来自 DB）。 */
  ipcMain.handle('vp:studio/sync', () => ({
    text: pendingStudioText,
    scenes: listPresets('scene'),
    tones: listPresets('tone'),
    defaultScene: getMeta('default_scene'),
  }));

  /** 关闭主应用窗口。 */
  ipcMain.handle('vp:studio/close', () => {
    getStudioWindow()?.close();
    return true;
  });

  /** 预设列表。 */
  ipcMain.handle('vp:preset/list', (_e, kind) => listPresets(kind));

  /** 新建/编辑预设（有 id 更新、无 id 新建）。 */
  ipcMain.handle('vp:preset/save', (_e, { id, kind, name, description }) => {
    const r = savePreset({ id: id ?? null, kind, name, description });
    // 返回后由渲染进程自己刷新列表
    return r;
  });

  /** 删除预设。内置返回 false。 */
  ipcMain.handle('vp:preset/delete', (_e, id) => deletePreset(Number(id)));

  /**
   * 润色入口（Task 5）：调用 streamPolish 流式润色，delta 逐块推回渲染进程。
   * 结果走三个事件：vp:polish/delta（增量）/ done（收尾）/ error（失败）。
   */
  ipcMain.handle('vp:polish/start', async (_e, { text, scene, tone }) => {
    const win = getStudioWindow();
    const emit = (channel, payload) => win?.webContents.send(channel, payload);

    try {
      await streamPolish({
        text, scene, tone,
        onDelta: (d) => emit('vp:polish/delta', { text: d }),
        onDone: () => emit('vp:polish/done', {}),
        onError: (e) => emit('vp:polish/error', { message: e.message }),
      });
    } catch (e) {
      emit('vp:polish/error', { message: e?.message ?? String(e) });
    }
    return true;
  });

  /** 历史写入。原文由渲染进程在 reviewing 时上报一次。返回新条目 id。 */
  ipcMain.handle('vp:history/save', (_e, { text }) => {
    const t = String(text ?? '');
    if (!t.trim()) return { id: null };
    const { id } = saveHistory({ text: t, durationMs: machine.lastDurationMs });
    console.log(`[历史] 已保存 #${id}（${t.length} 字，时长 ${machine.lastDurationMs ?? '?'}ms）`);
    return { id };
  });

  /** 历史列表（倒序）。 */
  ipcMain.handle('vp:history/list', () => listHistory({ limit: 200 }));

  /** 历史详情。 */
  ipcMain.handle('vp:history/get', (_e, id) => getHistory(Number(id)));

  /** 采用润色结果：把润色文本 + 场景/语气回写进本次会话的历史条目。 */
  ipcMain.handle('vp:polish/adopt', (_e, { polished, scene, tone }) => {
    if (pendingHistoryId != null) {
      updateHistoryPolish(pendingHistoryId, { polished, scene, tone });
    }
    return true;
  });

  /** 记录首次引导选择：职业 + 场景默认值 + 首次标志。 */
  ipcMain.handle('vp:onboarding/save', (_e, { profession }) => {
    setMeta('profession', profession);
    setMeta('default_scene', profession === 'product_rd' ? '文档' : '邮件');
    setMeta('first_run_done', 'true');
    return true;
  });

  /** 关闭引导窗。 */
  ipcMain.handle('vp:onboarding/close', () => {
    getOnboardingWindow()?.close();
    return true;
  });

  return machine;
}
