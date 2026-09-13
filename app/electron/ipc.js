import { app, clipboard, BrowserWindow, ipcMain, shell, systemPreferences } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionMachine, isBarFocusable } from './session/machine.js';
import { getCurrentLocale, setCurrentLocale } from './locale.js';
import { t } from '../shared/i18n/index.js';
import { createStudioWindow, getStudioWindow } from './studio.js';
import { getOnboardingWindow } from './onboarding.js';
import { getKeyEntryWindow } from './key-entry.js';
import { saveCredentials } from './asr/config.js';
import { listPresets, savePreset, deletePreset, getMeta, setMeta, saveHistory, listHistory, getHistory, updateHistoryPolish, updateHistoryText, deleteHistory, getShortcut, setShortcut } from './store.js';
import { streamPolish } from './llm/polish.js';
import { applyShortcut, currentAccel, defaultAccel, setShortcutSuspended } from './shortcut.js';
import { pasteTo } from './inject/index.js';

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

/**
 * 注入路径的诊断开关，与 inject 层用同一个环境变量（`VP_INJECT_DEBUG=1`）。
 * 这条路径没法自动测，真机排障只能靠它。
 */
const DEBUG_INJECT = process.env.VP_INJECT_DEBUG === '1';

// 这里**曾经**有一个 settleMs()（成功后等 250ms 再返回，让拆条晚于目标消费粘贴）。
// 已删除，理由见 vp:adopt/paste 里那段注释：它的依据是一个已被更根本的修法消除的
// 机制，真机复测（VP_ADOPT_SETTLE_MS=0）4/4 成功，说明它已无存在理由。

export function registerIpc({ getBar, requestQuit, attachDevLogging, resizeBar, resetBarHeight, rebuildTray }) {
  /**
   * 主进程 → 渲染进程。
   * 悬浮条可能还没加载完，也可能已被关闭，发送前必须检查。
   */
  const emit = (channel, payload) => {
    const bar = getBar();
    if (!bar || bar.isDestroyed()) return;
    // 只有 reviewing 需要键盘输入（编辑区）。聆听三态必须保持不可聚焦，
    // 否则「不抢焦点」（A2）就破了 —— 那是这个程序最硬的约束。
    // 映射抽到 isBarFocusable（session/machine.js）纯粹是为了让它有回归断言：
    // 这行被删掉时，界面自测看不见，只有那边的纯函数断言能拦下来。
    // 注意这里**不调用 focus()**：切成可聚焦只是允许用户点击进来。
    if (channel === 'vp:state') {
      const focusable = isBarFocusable(payload?.state);
      // 只在值真的变化时才切 focusable：setFocusable 会触发 SWP_FRAMECHANGED，
      // shell 收到 frame change 后会重新评估这个窗口并重建它的任务栏按钮。
      // 悬浮条是 skipTaskbar 窗口，本该完全没有任务栏按钮，也不能因为每次状态
      // 广播都来一次多余的 frame change 而被反复重建。
      if (bar.isFocusable() !== focusable) {
        bar.setFocusable(focusable);
        // frame change 会抵消 skipTaskbar 已有的效果，立刻重申一次，
        // 保证「不抢焦点」（A2）之外的另一个窗口属性——不在任务栏露脸——也守得住。
        bar.setSkipTaskbar(true);
      }
      // 会话回到 idle/warming 时把窗口收回基础高度。resizeBar 只增不减，不复位
      // 就会让下一段空文本继承上一段的高窗（见 main.js resetBarHeight）。listening/
      // draining 会长文本、reviewing 要放编辑区，都不复位。
      if (payload?.state === 'idle' || payload?.state === 'warming') resetBarHeight();
    }
    bar.webContents.send(channel, payload);
  };

  function broadcastLocale(locale) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send('vp:lang/changed', locale);
      // 已打开的二级窗口（studio/onboarding/key-entry/diag）标题栏也要跟着切。
      // 窗口创建时把对应字典 key 存到 win.vpTitleKey（悬浮条/自测窗没标题，跳过）。
      if (win.vpTitleKey) win.setTitle(t(locale, win.vpTitleKey));
    }
  }

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

  /**
   * 采纳写回：把剪贴板里的文本粘到「快捷键触发那一刻的前台窗口」。
   *
   * 剪贴板由渲染进程先经 vp:copy 写好，这里只负责置前 + 发粘贴键 ——
   * 这样「复制」与「采纳」共用同一条剪贴板写入路径，不会出现两边写的内容不一致。
   * **不还原剪贴板**（spec §0 决策 2）。
   */
  ipcMain.handle('vp:adopt/paste', async () => {
    // 诊断：读**悬浮条自己**的 DOM 状态。这是「按键到底投给了谁」最直接的证据 ——
    // 若粘进来的文本出现在我们自己的编辑区里，就说明按键落在我们窗口里了。
    //
    // ⚠️ 只比 `editor`，**不要**比 hasFocus：目标接管焦点后我们这边 hasFocus 翻成 false
    // 是**正常**的，拿它做「状态变了」的判据会必然误报（这条踩过）。
    const probeBar = async (tag) => {
      if (!DEBUG_INJECT) return null;
      const bar = getBar();
      if (!bar || bar.isDestroyed()) {
        console.log(`[注入] 悬浮条(${tag}): 窗口不存在`);
        return null;
      }
      try {
        const s = await bar.webContents.executeJavaScript(
          `JSON.stringify({
             hasFocus: document.hasFocus(),
             active: document.activeElement ? document.activeElement.tagName : null,
             editor: (document.querySelector('[data-testid="bar-editor"]') || {}).value ?? null
           })`
        );
        console.log(`[注入] 悬浮条(${tag}): ${s}`);
        return JSON.parse(s);
      } catch (e) {
        console.log(`[注入] 悬浮条(${tag}) 读取失败: ${e?.message ?? e}`);
        return null;
      }
    };

    const before = await probeBar('发键前');

    const bar = getBar();
    const barAlive = () => bar && !bar.isDestroyed();

    /**
     * 切悬浮条的可聚焦性，并且**永远和 setSkipTaskbar(true) 成对**。
     *
     * setFocusable() 会触发 SWP_FRAMECHANGED；shell 收到 frame change 后会重新评估
     * 这个窗口并重建它的任务栏按钮，从而抵消 skipTaskbar 已有的效果（f5e93f5 修过的
     * 真 bug）。emit() 里每次切完都紧跟一次 setSkipTaskbar(true)，但采纳路径是直接
     * 调的，绕过了那条成对逻辑 —— 而且成功后紧接着的 emit(idle) 会因为 isFocusable()
     * 已等于目标值而整段跳过，那个 re-assert 永远等不到。所以这里也走成对入口。
     */
    const setBarFocusable = (focusable) => {
      if (!barAlive()) return;
      bar.setFocusable(focusable);
      bar.setSkipTaskbar(true);
    };

    // 先把自己的可聚焦性交出去，再动手置前目标。
    //
    // 为什么必须在**置前之前**：用户点「采纳」时悬浮条是可聚焦的（reviewing 态），
    // 而关闭路径会调 setFocusable(false)，那会触发 SWP_FRAMECHANGED 样式变更。
    // 在我们自己的窗口上做这种变更，会把激活从目标应用手里扰动走 ——
    // 发键前扰动，粘贴作废；发键后扰动，粘贴能活但**光标回不到目标**（真机反馈：
    // 采纳成功后光标不在 Word 里，得点一下才能继续打字）。
    //
    // 提前交出去之后，拆条时的这次变更就成了空操作（emit 里 isFocusable 相同则跳过），
    // 于是没人再去动目标的激活。失败时把可聚焦还回来 —— 用户还要在条里看提示并重试。
    //
    // 名字用 wasFocusable 而不是 hadFocus：isFocusable() 的语义是「这个窗口**允许**
    // 被聚焦」，不是「用户此刻正聚焦在它上面」。
    const wasFocusable = barAlive() && bar.isFocusable();
    if (wasFocusable) setBarFocusable(false);

    let r;
    try {
      r = await pasteTo(machine.getTarget());
    } finally {
      // ⚠️ 是否恢复**必须按当前状态**判断，不能拿上面的 wasFocusable 当条件。
      // pasteTo 至少要等满一次激活等待（≥60ms），这期间状态可能已经离开 reviewing
      // （用户点了关闭，或连按两次快捷键：reviewing → dismiss → idle → warming）。
      // 那时再把 focusable 置回 true，悬浮条就会在 warming/listening 期间**可聚焦**，
      // 直接违反 A2 —— 而 emit() 只在**下一次**状态广播时才重同步，拦不住这一次。
      //
      // 放在 finally 里是因为 pasteTo 若抛异常，今天那样会直接跳过恢复，用户在
      // reviewing 里既不能编辑也不能重试。
      if (!r?.ok && isBarFocusable(machine.getSnapshot()?.state)) setBarFocusable(true);
    }

    // 这里**曾经**有一段「成功后先等 250ms 再返回」的延时，用来让拆条晚于目标消费粘贴。
    // 已删除 —— 因为它的依据是个已被移除的机制：当时测到 0/4 vs 4/4 的对照，早于
    // 「置前前先交出可聚焦性」落地，而那个改动让拆条时的 `setFocusable` 变成空操作。
    // 结构上现在两条路径都不再扰动目标：
    //   · 悬浮条原本可聚焦 → 上面已提前置为不可聚焦 → emit 看到值未变 → 跳过样式变更；
    //   · 原本就不可聚焦 → emit 同样跳过。
    // 也就是说「拆条改窗口样式」这件事已经不可能发生，延时无从防起。
    // 真机复测（Word，`VP_ADOPT_SETTLE_MS=0`）：4/4 成功、光标仍留在目标。
    // 若将来某台机器又复现「粘贴丢失」，先怀疑拆条里剩下的动作（`resetBarHeight` 的
    // 尺寸复位、渲染层 unmount），而不是先把这段等待加回来。

    if (DEBUG_INJECT) {
      // ⚠️ 这段等待**只服务于下面这次读数**，不在产品路径上。
      // 但看日志时要留意：它同样会把「拆条过早」类的问题掩盖掉 —— 所以它只在
      // DEBUG 下存在，不能拿 DEBUG 下的成功去证明产品路径没问题。
      await new Promise((res) => setTimeout(res, 250));
      const after = await probeBar('发键后');
      if (before && after && before.editor !== after.editor) {
        console.warn('[注入] ⚠️ 悬浮条编辑区内容在发键后变了 —— 按键落在了我们自己窗口里');
      }
    }
    return r;
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

  // ---------------------------------------------------------------- 快捷键（F7）

  /** 读当前快捷键。isDefault 表示用户没自定义过。 */
  ipcMain.handle('vp:shortcut/get', () => {
    const custom = getShortcut();
    return { accel: custom ?? defaultAccel(), isDefault: custom == null };
  });

  /**
   * 设置快捷键。成功则落库并重注册；失败（冲突）返回 ok:false 且不改动。
   * 注册逻辑见 shortcut.js。
   */
  ipcMain.handle('vp:shortcut/set', (_e, accel) => {
    const next = String(accel ?? '').trim();
    if (!next) return { ok: false, accel: currentAccel() };
    const ok = applyShortcut(machine, next);
    if (ok) setShortcut(next);
    return { ok, accel: currentAccel() };
  });

  /**
   * 录制期间挂起 / 恢复全局快捷键。挂起后按下的组合键不会被当成听写，
   * 只会被渲染进程的录制控件捕获。见 shortcut.js 的 setShortcutSuspended。
   */
  ipcMain.handle('vp:shortcut/suspend', (_e, suspended) => {
    setShortcutSuspended(Boolean(suspended));
    return true;
  });

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

  /** 主应用挂载时拉一次：待润色文本 + 场景/语气预设（来自 DB，按当前 locale 取名）。 */
  ipcMain.handle('vp:studio/sync', () => {
    const locale = getCurrentLocale();
    return {
      text: pendingStudioText,
      scenes: listPresets('scene', locale),
      tones: listPresets('tone', locale),
      defaultSceneId: getMeta('default_scene_id') ? Number(getMeta('default_scene_id')) : null,
    };
  });

  /** 关闭主应用窗口。 */
  ipcMain.handle('vp:studio/close', () => {
    getStudioWindow()?.close();
    return true;
  });

  /** 预设列表。按当前 locale 取名，让 PresetManager 显示三语名。 */
  ipcMain.handle('vp:preset/list', (_e, kind) => listPresets(kind, getCurrentLocale()));

  /** 新建/编辑预设（有 id 更新、无 id 新建）。lang 记当前 locale（主进程兜底）。 */
  ipcMain.handle('vp:preset/save', (_e, { id, kind, name, description, lang }) => {
    const r = savePreset({ id: id ?? null, kind, name, description, lang: lang ?? getCurrentLocale() });
    // 返回后由渲染进程自己刷新列表
    return r;
  });

  /** 删除预设。内置返回 false。 */
  ipcMain.handle('vp:preset/delete', (_e, id) => deletePreset(Number(id)));

  /**
   * 悬浮条润色所需的预设。与 vp:studio/sync 同款数据，但不带文本 ——
   * 悬浮条的文本归渲染进程所有，不需要（也不应该）经过主进程转发。
   */
  ipcMain.handle('vp:polish/presets', () => {
    const locale = getCurrentLocale();
    return {
      scenes: listPresets('scene', locale),
      tones: listPresets('tone', locale),
      defaultSceneId: getMeta('default_scene_id') ? Number(getMeta('default_scene_id')) : null,
    };
  });

  /**
   * 润色入口（Task 5）：调用 streamPolish 流式润色，delta 逐块推回渲染进程。
   * 结果走三个事件：vp:polish/delta（增量）/ done（收尾）/ error（失败）。
   */
  ipcMain.handle('vp:polish/start', async (_e, { text, scene, tone, target }) => {
    // last-used 默认场景：记住本次润色用的场景 id（稳定，不随 locale 变），
    // 下次打开默认选中。独立 try 避免影响润色本身。
    try { if (scene?.id != null) setMeta('default_scene_id', scene.id); } catch {}

    // 事件发给发起方所在窗口。悬浮条内润色（target='bar'）必须回到悬浮条，
    // 否则流式结果发到主应用窗口，悬浮条下半栏永远空白。
    //
    // win 为空（悬浮条还没建 / 已关）时必须返回 false：以前 win?.webContents.send
    // 会静默吞掉所有 delta/done/error，而 handler 照样返回 true —— 渲染进程的
    // polishing 就永远停在 true，按钮卡死禁用。返回 false 让渲染进程能收尾。
    const win = target === 'bar' ? getBar() : getStudioWindow();
    if (!win || win.isDestroyed()) return false;
    const emit = (channel, payload) => {
      // 窗口在流式过程中被销毁也要挡住：webContents.send 对 destroyed 窗口会抛，
      // 而逐个事件 try/catch 只会把真正的错误埋掉。
      if (win.isDestroyed()) return;
      win.webContents.send(channel, payload);
    };

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

  /** 删除一条历史。返回是否真的删掉了。 */
  ipcMain.handle('vp:history/delete', (_e, id) => deleteHistory(Number(id)));

  /** 编辑后更新同一条历史的正文。悬浮条在采纳/复制/关闭/打开应用时调用。 */
  ipcMain.handle('vp:history/update-text', (_e, { id, text }) => {
    const n = Number(id);
    if (!Number.isFinite(n)) return false;
    // 透传 store 的 r.changes>0：id 不存在时诚实返回 false，
    // 而不是无论改没改到都回 true。
    return updateHistoryText(n, String(text ?? ''));
  });

  /**
   * 采用润色结果：把润色文本 + 场景/语气回写进本次会话的历史条目。
   *
   * id 优先：悬浮条（bar）自己发起的会话与主应用窗口无关，必须显式带上本条
   * 历史的 id。省略时才回退到 pendingHistoryId —— 那是 Studio 一路的旧行为：
   * 主应用经 vp:studio/open 打开时设下该值，Studio 采纳时不再单独传 id。
   * 悬浮条不设 pendingHistoryId，所以以前这里要么写不进去（null），要么写错行
   * （上一次「打开应用」留下的陈旧 id）。
   */
  ipcMain.handle('vp:polish/adopt', (_e, { id, polished, scene, tone }) => {
    const target = id != null ? Number(id) : pendingHistoryId;
    if (target != null) {
      updateHistoryPolish(target, { polished, scene, tone });
    }
    return true;
  });

  /** 关闭引导窗。 */
  ipcMain.handle('vp:onboarding/close', () => {
    getOnboardingWindow()?.close();
    return true;
  });

  /** 保存用户输入的 API Key + 工作空间 ID（safeStorage 加密落盘，见 asr/config.js）。 */
  ipcMain.handle('vp:key/save', (_e, { apiKey, workspaceId }) => {
    const key = String(apiKey ?? '').trim();
    const ws = String(workspaceId ?? '').trim();
    const locale = getCurrentLocale();
    if (!key || !ws) throw new Error(t(locale, 'key.emptyError'));
    try {
      saveCredentials({ apiKey: key, workspaceId: ws });
    } catch {
      // 只可能是 normalizeCreds 判不合法；具体原因不暴露给渲染进程
      throw new Error(t(locale, 'key.invalidError'));
    }
    return true;
  });

  /** 关闭「设置 API Key」窗口。 */
  ipcMain.handle('vp:key/close', () => {
    getKeyEntryWindow()?.close();
    return true;
  });

  // ---------------------------------------------------------------- 语言（i18n）

  ipcMain.handle('vp:lang/get', () => ({ locale: getCurrentLocale() }));

  ipcMain.handle('vp:lang/set', (_e, locale) => {
    const ok = setCurrentLocale(locale);
    if (!ok) return { ok: false, locale: getCurrentLocale() };
    broadcastLocale(locale);
    rebuildTray?.();
    return { ok: true, locale };
  });

  // ---------------------------------------------------------------- 权限（F12）

  /** macOS 辅助功能授权状态。非 macOS 返回 null（表示「不适用」）。 */
  ipcMain.handle('vp:permission/status', () => ({
    accessibility:
      process.platform === 'darwin'
        ? systemPreferences.isTrustedAccessibilityClient(false)
        : null,
  }));

  /**
   * 打开系统设置 → 辅助功能页（macOS 深链）。非 macOS 空操作。
   * URL 用经典写法；macOS 13+ 系统设置改版后若跳转失效，换成
   * 'x-apple.systempreferences:com.apple.settings.privacy?Privacy_Accessibility'
   * （真机验证见 Task 3）。
   */
  ipcMain.handle('vp:permission/open-settings', async () => {
    if (process.platform !== 'darwin') return false;
    try {
      await shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
      );
      return true;
    } catch {
      // 深链失败（极少见）：返回 false，用户可手动走文字步骤
      return false;
    }
  });

  return machine;
}
