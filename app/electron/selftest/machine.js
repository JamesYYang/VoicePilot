import { SessionMachine, isBarFocusable } from '../session/machine.js';
import { AudioQueue } from '../session/audio-queue.js';

/**
 * 状态机与背压自测。用法：
 *   cd app && VP_SM_SELFTEST=1 npx electron .
 *
 * 存在的理由：状态机的四条异常收敛路径（取消、收尾超时、限流重试耗尽、
 * 非限流错误）在真机上要么很难触发，要么要靠打满百炼并发才能触发。
 * 用假会话注入，这几条路径就能秒级、确定性地验一遍。
 *
 * 与 selftest/asr.js 的分工：那边验**协议**（真实 AsrSession 跑完整会话），
 * 这边验**状态流转**（假会话 + 注入的时序）。两者不重叠，都便宜。
 */

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: Boolean(cond), detail });
  console.log(`${cond ? ' ok ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => sleep(0);

/** 假会话：把 start/stop/abort 都变成可手动控制的开关。 */
class FakeSession {
  constructor(opts) {
    this.opts = opts;
    this.state = 'idle';
    this.sent = [];
    this.buffered = 0;
    this.aborted = false;
    this.stopCalled = false;
    this.truncated = false;
    this.startHeld = false;
    this.#resolveStart = null;
    this.startedPromise = new Promise((r) => (this.#resolveStart = r));
    FakeSession.last = this;
    FakeSession.all.push(this);
  }
  #resolveStart;

  async start() {
    this.state = 'starting';
    if (this.startHeld) await this.startedPromise;
    this.state = 'streaming';
  }
  sendAudio(chunk) {
    this.sent.push(chunk);
    this.buffered += chunk.byteLength;
    return { ok: true, sentAtMs: Date.now(), bufferedBytes: this.buffered };
  }
  async stop() {
    this.stopCalled = true;
    this.state = 'closed';
    if (this.opts.onLifecycle) this.opts.onLifecycle({ type: 'task-finished', recvAtMs: Date.now() });
    return { truncated: this.truncated };
  }
  abort() {
    this.aborted = true;
    this.state = 'closed';
  }
  get bufferedBytes() {
    return this.buffered;
  }
  // —— 测试驱动用的便捷方法 ——
  fireResult(ev) {
    this.opts.onResult?.({ recvAtMs: Date.now(), words: [], ...ev });
  }
  fireError(e) {
    this.opts.onError?.(e);
  }
  fireClosed(e) {
    this.opts.onClosed?.(e);
  }
  releaseStart() {
    this.#resolveStart();
  }
}
FakeSession.all = [];

function makeMachine(opts = {}) {
  FakeSession.all = [];
  const emitted = { state: [], error: [], partial: [] };
  const machine = new SessionMachine({
    emit: (channel, payload) => {
      if (channel === 'vp:state') emitted.state.push(payload.state);
      if (channel === 'vp:error') emitted.error.push(payload);
      if (channel === 'vp:asr/partial') emitted.partial.push(payload);
    },
    credentials: { apiKey: 'test-key', workspaceId: 'test-workspace' },
    maxAttempts: opts.maxAttempts ?? 3,
    backoffMs: opts.backoffMs ?? [10, 20, 30],
    createSession: (o) => {
      const s = new FakeSession(o);
      if (opts.holdStart) s.startHeld = true;
      return s;
    },
  });
  return { machine, emitted, sessions: FakeSession.all };
}

// ---------------------------------------------------------------- 用例

async function testNormalFlow() {
  console.log('\n[1] 正常流程 idle → warming → listening → draining → reviewing → idle');
  const { machine, emitted } = makeMachine({ holdStart: true });

  // 不能 await：holdStart 让会话卡在建立中，await 会一直挂住，
  // 而 warming 恰恰就是这段「会话还没就绪」的时间窗 —— 必须先拿到 pending，
  // 观察完再放行。
  const pending = machine.toggle();
  await tick();
  check('按快捷键进入 warming', machine.state === 'warming', machine.state);

  // warming 期间送来的音频只进队列，不发出去（会话还没就绪）
  machine.onAudioFrame({ seq: 1, cumSamples: 1600 }, Buffer.alloc(3200));
  check('warming 期间不发送音频', FakeSession.all[0].sent.length === 0);

  FakeSession.all[0].releaseStart();
  await pending;
  await tick();
  check('task-started 后进入 listening', machine.state === 'listening', machine.state);
  check('缓冲的音频随后被发出', FakeSession.all[0].sent.length === 1, `发了 ${FakeSession.all[0].sent.length} 帧`);

  await machine.toggle();
  check('再次触发进入 draining', emitted.state.includes('draining'));
  check('收尾后进入 reviewing', machine.state === 'reviewing', machine.state);
  check('未截断', machine.getSnapshot().truncated === false);

  await machine.toggle();
  check('reviewing 下触发回到 idle', machine.state === 'idle', machine.state);
}

async function testCancelDuringWarming() {
  console.log('\n[2] warming 期间再次触发 = 取消');
  const { machine, sessions } = makeMachine({ holdStart: true });

  // 同样不能 await 第一次 toggle：它卡在会话建立中，这正是我们要取消的状态
  machine.toggle();
  await tick();
  await machine.toggle();

  check('回到 idle', machine.state === 'idle', machine.state);
  check('会话被 abort', sessions[0].aborted === true);
  // 关键：不能走 stop 流程。等 task-started 再正常停止要白等最多 15 秒，
  // 而且这段时间的空会话照样计费。
  check('没有调用 stop（不等收尾）', sessions[0].stopCalled === false);
}

async function testDrainingTruncated() {
  console.log('\n[3] 收尾超时：强制回收，保留状态');
  const { machine } = makeMachine();
  await machine.toggle();
  FakeSession.all[0].truncated = true; // stop() 报告没等到 task-finished
  await machine.toggle();

  check('超时也进入 reviewing（不卡死）', machine.state === 'reviewing', machine.state);
  check('标记 truncated', machine.getSnapshot().truncated === true);
}

async function testThrottlingRetry() {
  console.log('\n[4] 限流：退避重试，耗尽后收敛');
  const { machine } = makeMachine({ maxAttempts: 2, backoffMs: [10, 20] });
  await machine.toggle();
  check('已进入 listening', machine.state === 'listening', machine.state);

  FakeSession.all[0].fireError({
    kind: 'throttling',
    code: 'Throttling.RateQuota',
    message: 'qps exceeded',
  });

  const snap = machine.getSnapshot();
  check('限流时仍停留在 listening（用户还在说）', machine.state === 'listening', machine.state);
  check('带出重试提示', snap.notice?.kind === 'throttling' && snap.notice?.attempt === 1,
    JSON.stringify(snap.notice));

  await sleep(40);
  check('退避后开了新会话（新 task_id）', FakeSession.all.length === 2, `共 ${FakeSession.all.length} 个会话`);

  // 第 2 次限流：用掉最后一次重试机会（maxAttempts=2 表示允许重试 2 次，
  // 所以总共会出现 3 个会话，第 3 个再失败才收敛）
  FakeSession.all[1].fireError({
    kind: 'throttling',
    code: 'Throttling.RateQuota',
    message: 'qps exceeded',
  });
  await sleep(60);
  check('第二次重试后共 3 个会话', FakeSession.all.length === 3, `共 ${FakeSession.all.length} 个会话`);

  // 第 3 次限流：次数已用尽，不该再开新会话
  FakeSession.all[2].fireError({
    kind: 'throttling',
    code: 'Throttling.RateQuota',
    message: 'qps exceeded',
  });
  await tick();
  check('重试次数用尽后收敛到 reviewing', machine.state === 'reviewing', machine.state);
  check('不再新建会话', FakeSession.all.length === 3, `共 ${FakeSession.all.length} 个会话`);
}

async function testNonRetryableError() {
  console.log('\n[5] 非限流错误：不重试，立刻收敛');
  const { machine, emitted } = makeMachine();
  await machine.toggle();

  FakeSession.all[0].fireError({ kind: 'key', code: '401', message: 'InvalidApiKey' });
  await tick();

  check('密钥错误直接进 reviewing', machine.state === 'reviewing', machine.state);
  check('只建了一个会话（没有无谓重试）', FakeSession.all.length === 1);
  check('错误带 preserveText 提示', emitted.error[0]?.preserveText === true);
}

async function testBackpressure() {
  console.log('\n[6] 背压：队列上限与暂停阈值');
  const q = new AudioQueue({ maxFrames: 5 });
  for (let i = 0; i < 12; i++) {
    q.push({ seq: i, cumSamples: (i + 1) * 1600, pcm: Buffer.alloc(3200) });
  }
  check('队列卡在上限 5 帧', q.length === 5, `实际 ${q.length}`);
  check('丢弃了 7 帧', q.dropped === 7, `实际 ${q.dropped}`);
  check('留下的是最新的几帧', q.q[0].seq === 7 && q.q[4].seq === 11, `seq ${q.q[0].seq}..${q.q[4].seq}`);

  const sink = {
    state: 'streaming',
    buffered: 0,
    sent: [],
    sendAudio(c) {
      this.sent.push(c);
      this.buffered += c.byteLength;
      return { ok: true, sentAtMs: Date.now(), bufferedBytes: this.buffered };
    },
    get bufferedBytes() {
      return this.buffered;
    },
  };

  const r1 = q.drain(sink, () => {});
  check('正常情况全部发出', r1.sent === 5 && q.length === 0, `发 ${r1.sent} 剩 ${q.length}`);

  q.push({ seq: 20, cumSamples: 1600, pcm: Buffer.alloc(3200) });
  sink.buffered = 40000; // 超过 32KB 暂停阈值
  const r2 = q.drain(sink, () => {});
  check('积压超阈值时暂停发送', r2.sent === 0, `发了 ${r2.sent}`);
  check('音频仍留在队列里', q.length === 1);
}

// ---------------------------------------------------------------- 入口

/** A2 回归护栏：悬浮条焦点只允许 reviewing 与 phrases 两个状态。 */
async function testBarFocusable() {
  console.log('\n[7] A2：悬浮条仅 reviewing 与 phrases 可聚焦');
  check('reviewing 可聚焦（编辑区需要键盘输入）', isBarFocusable('reviewing') === true);
  check('idle 不可聚焦', isBarFocusable('idle') === false);
  check('warming 不可聚焦（A2 硬约束）', isBarFocusable('warming') === false);
  check('listening 不可聚焦（A2 硬约束）', isBarFocusable('listening') === false);
  check('draining 不可聚焦（A2 硬约束）', isBarFocusable('draining') === false);
  check('phrases 可聚焦（选择器需要键盘输入）', isBarFocusable('phrases') === true);
}

// ---------------------------------------------------------------- 采纳目标窗口

/**
 * 采纳写回的目标窗口：捕获时机与生命周期。
 * 捕获**必须在进 warming 之前**发生 —— 那之后悬浮条开始渲染，前台可能变成我们自己。
 */
async function testCaptureTarget() {
  console.log('\n[8] 采纳目标窗口：捕获时机与生命周期');

  let calls = 0;
  let stateAtCapture = null;
  let session = null;
  const holder = {};
  const m = new SessionMachine({
    emit() {},
    // 会话卡在建立中：start() 才会停在 warming，第二次 toggle 才走「取消」路径。
    // 不 hold 的话 start() 直接进 listening，toggle 会变成 stop → reviewing，
    // 那验的就是别的生命周期了。
    createSession: () => {
      session = new FakeSession({});
      session.startHeld = true;
      return session;
    },
    credentials: {},
    captureTarget: () => {
      calls += 1;
      stateAtCapture = holder.m.state;
      return { kind: 'win', hwnd: 7 };
    },
  });
  holder.m = m;

  // 不能 await：会话被 hold，await 会一直挂住 —— 而 warming 恰恰就是这段等待窗。
  // 捕获跑在第一个 await 之前，所以这一行调用后目标就已经取好了。
  const pending = m.start();
  await tick();
  check('start 时捕获一次', calls === 1, `捕获 ${calls} 次`);
  check('捕获发生在进 warming 之前', stateAtCapture === 'idle', String(stateAtCapture));
  check('目标已持有', m.getTarget() !== null, JSON.stringify(m.getTarget()));

  await m.toggle(); // warming → 取消
  check('取消后清空目标', m.getTarget() === null, JSON.stringify(m.getTarget()));
  check('取消后回到 idle', m.state === 'idle', m.state);

  // 放行被取消的会话，让 start() 的 promise 收尾，别留下悬挂的 pending
  session.releaseStart();
  await pending;

  // reviewing → dismiss 是另一条到 idle 的路径，也必须清空目标。
  // 不 hold 会话：start() 直接走到 listening，再 toggle 一次即 stop → draining → reviewing。
  const m2 = new SessionMachine({
    emit() {},
    createSession: () => new FakeSession({}),
    credentials: {},
    captureTarget: () => ({ kind: 'win', hwnd: 11 }),
  });
  await m2.start();
  await m2.toggle(); // listening → draining → reviewing
  check('reviewing 期目标仍持有（采纳就是在这时用它）', m2.getTarget() !== null, JSON.stringify(m2.getTarget()));
  await m2.toggle(); // reviewing → dismiss
  check('dismiss 后清空目标', m2.getTarget() === null, JSON.stringify(m2.getTarget()));
}

// ---------------------------------------------------------------- 常用语选择器

/**
 * 第六态 phrases：捕获时机、状态门禁、origin、以及焦点归还的顺序与闸门取样时机。
 * 真实的 focus() 与置前没法自动验（spec §6 风险 1/3），这里验的是**编排**：
 * 置前必须在拆状态之后，而闸门必须在拆状态之前 —— 两处顺序都是安全属性。
 */
async function testPhrases() {
  console.log('\n[9] 常用语选择器：捕获时机 / 状态门禁 / origin / 焦点归还');

  const mk = (opts = {}) => {
    FakeSession.all = []; // 每个用例从零开始数会话，否则「不建会话」的断言数不准
    const calls = { capture: 0, activate: 0 };
    const activated = [];
    const stateAtActivate = []; // 置前那一刻的状态：用来锁住「先回 idle 再置前」的顺序
    const stateAtGate = []; // 读闸门那一刻的状态：用来锁住「先取样闸门再拆状态」的顺序
    let restore = opts.shouldRestoreFocus ?? true;
    const holder = {};
    const m = new SessionMachine({
      emit() {},
      credentials: {},
      createSession: () => new FakeSession({}),
      captureTarget: () => {
        calls.capture += 1;
        return { kind: 'win', hwnd: 5 };
      },
      activateTarget: async (t) => {
        calls.activate += 1;
        activated.push(t);
        stateAtActivate.push(holder.m.state);
        return { ok: true };
      },
      shouldRestoreFocus: () => {
        stateAtGate.push(holder.m.state);
        return restore;
      },
    });
    holder.m = m;
    return { m, calls, activated, stateAtActivate, stateAtGate };
  };

  // ---- 捕获发生在进 phrases 之前，且只捕获一次 ----
  const a = mk();
  await a.m.openPhrases();
  check('openPhrases 进 phrases 态', a.m.state === 'phrases', a.m.state);
  check('捕获一次', a.calls.capture === 1, `${a.calls.capture} 次`);
  check('进 phrases 前已持有目标', a.m.getTarget() !== null, JSON.stringify(a.m.getTarget()));

  // ---- 非 idle 态一律忽略 ----
  const b = mk();
  await b.m.start();
  check('listening 下 openPhrases 被忽略',
    (await b.m.openPhrases()).ignored === true && b.m.state === 'listening', b.m.state);

  // 主快捷键在 phrases 态同样忽略（不串「关掉并开始听写」两个跃迁）
  const c = mk();
  await c.m.openPhrases();
  await c.m.toggle();
  check('主快捷键在 phrases 态被忽略', c.m.state === 'phrases', c.m.state);

  // ---- usePhrase：origin 翻成 phrase，目标保留 ----
  const d = mk();
  await d.m.openPhrases();
  await d.m.usePhrase();
  check('usePhrase 进 reviewing', d.m.state === 'reviewing', d.m.state);
  check('origin 翻成 phrase', d.m.getSnapshot().origin === 'phrase', d.m.getSnapshot().origin);
  check('reviewing 期目标仍持有（采纳要用）', d.m.getTarget() !== null, JSON.stringify(d.m.getTarget()));

  // ---- 关掉选择器：回 idle、清空目标、归还焦点 ----
  const e = mk();
  await e.m.openPhrases();
  await e.m.openPhrases(); // 再按一次 = 关闭
  check('再按一次回到 idle', e.m.state === 'idle', e.m.state);
  check('关闭后清空目标', e.m.getTarget() === null, JSON.stringify(e.m.getTarget()));
  check('关闭时归还焦点一次', e.calls.activate === 1, `${e.calls.activate} 次`);
  check('归还的是捕获到的那个目标',
    JSON.stringify(e.activated[0]) === JSON.stringify({ kind: 'win', hwnd: 5 }),
    JSON.stringify(e.activated[0]));
  // 顺序是安全属性：置前必须发生在回 idle（= setFocusable(false) / resetBarHeight 落地）
  // **之后**，否则那两下改动会把刚建立的激活扰动走。这条断言专门锁住顺序 ——
  // 只数次数的话，把 await 提到 setState 之前也是绿的，等于没测。
  check('归还发生在回 idle 之后（顺序是安全属性）',
    e.stateAtActivate[0] === 'idle', String(e.stateAtActivate[0]));
  // 闸门与置前的顺序恰好相反，同样是安全属性：回 idle 会 setFocusable(false)，
  // 不可聚焦的窗口随即失去焦点，事后再读闸门只会拿到 false —— 归还静默从不发生。
  // 生产里这个谓词是 () => bar.isFocused()，不是固定值，所以单测必须钉住读取时机。
  check('闸门在回 idle 之前取样（否则永远读到 false）',
    e.stateAtGate[0] === 'phrases', String(e.stateAtGate[0]));

  // ---- 闸门：条不持有焦点时不归还（避免把焦点从用户刚切过去的应用拽回来）----
  const f = mk({ shouldRestoreFocus: false });
  await f.m.openPhrases();
  await f.m.openPhrases();
  check('闸门为 false 时不置前', f.calls.activate === 0, `${f.calls.activate} 次`);

  // ---- 从常用语来的 reviewing 关闭时同样归还；听写来的不归还 ----
  const g = mk();
  await g.m.openPhrases();
  await g.m.usePhrase();
  await g.m.toggle(); // reviewing → dismiss
  check('从常用语来的 reviewing 关闭时归还焦点', g.calls.activate === 1, `${g.calls.activate} 次`);
  check('关闭后 origin 复位 dictation',
    g.m.getSnapshot().origin === 'dictation', g.m.getSnapshot().origin);
  check('dismiss 路径同样先回 idle 再置前', g.stateAtActivate[0] === 'idle', String(g.stateAtActivate[0]));
  // 同理：dismiss 路的闸门也得在 #setState('idle') 之前读，此时还停在 reviewing。
  check('dismiss 路径的闸门在回 idle 之前取样（此时仍在 reviewing）',
    g.stateAtGate[0] === 'reviewing', String(g.stateAtGate[0]));

  const h = mk();
  await h.m.start();
  await h.m.toggle(); // → reviewing（origin 仍是 dictation）
  check('听写来的 reviewing origin=dictation',
    h.m.getSnapshot().origin === 'dictation', h.m.getSnapshot().origin);
  await h.m.toggle(); // dismiss
  check('听写来的 reviewing 关闭时不置前（既有行为不变）',
    h.calls.activate === 0, `${h.calls.activate} 次`);

  // 采纳成功：dismissForAdopt 关条并同时记下**这次写回用的**目标；拆条那一刻还不置前，
  // 等渲染进程拆完编辑区再 restorePending 归还（顺序是安全属性，见 #settleToIdle）。
  const adopt = mk({ shouldRestoreFocus: false });
  await adopt.m.start();
  await adopt.m.toggle(); // → reviewing
  const adopted = await adopt.m.dismissForAdopt();
  check('采纳成功：dismissForAdopt 关条回 idle',
    adopted.closed === true && adopt.m.state === 'idle',
    JSON.stringify({ r: adopted, state: adopt.m.state }));
  check('采纳关闭时还不置前（等 restorePending）',
    adopt.calls.activate === 0, `${adopt.calls.activate} 次`);
  await adopt.m.restorePending();
  check('restorePending 后归还焦点', adopt.calls.activate === 1, `${adopt.calls.activate} 次`);
  check('归还的是这次写回用的那个目标',
    JSON.stringify(adopt.activated[0]) === JSON.stringify({ kind: 'win', hwnd: 5 }),
    JSON.stringify(adopt.activated[0]));
  check('采纳归还发生在回 idle 之后',
    adopt.stateAtActivate[0] === 'idle', String(adopt.stateAtActivate[0]));

  // 状态已被用户抢走（写回那 100+ms 里连按快捷键 / 手动关条）→ 不许再关一次。
  // 锁的是「按**当前**状态分派」这个坑：idle 上 toggle 会去 start()，等于把用户的
  // 下一次听写吃掉（warming 上则是 cancel）。闸门必须比这条路径先拦下来。
  const stolen = mk({ shouldRestoreFocus: false });
  await stolen.m.start();
  await stolen.m.toggle(); // → reviewing
  await stolen.m.toggle(); // 用户抢先关掉 → idle
  FakeSession.all = []; // 从这一刻起数会话，把上面那次 start() 排除掉
  const afterSteal = await stolen.m.dismissForAdopt();
  check('状态已离开 reviewing 时不再关条',
    afterSteal.closed === false && stolen.m.state === 'idle',
    JSON.stringify({ r: afterSteal, state: stolen.m.state }));
  check('状态已离开 reviewing 时不建新会话（不吞掉用户的下一次听写）',
    FakeSession.all.length === 0, `${FakeSession.all.length} 个会话`);
  await stolen.m.restorePending();
  check('状态已离开 reviewing 时不置前', stolen.calls.activate === 0, `${stolen.calls.activate} 次`);

  // 重复调用（双击采纳、两次 IPC 竞态）：第二次不许把已记下的归还目标冲掉 ——
  // 冲掉的表现是 restorePending 变成空操作、焦点静默不还，所以断言落在 activate 次数上。
  const dup = mk({ shouldRestoreFocus: false });
  await dup.m.start();
  await dup.m.toggle(); // → reviewing
  await dup.m.dismissForAdopt();
  const dupAgain = await dup.m.dismissForAdopt();
  check('重复调用不再关条（此时已不在 reviewing）',
    dupAgain.closed === false, JSON.stringify(dupAgain));
  await dup.m.restorePending();
  check('重复调用后仍然只归还一次（目标没被冲掉）',
    dup.calls.activate === 1, `${dup.calls.activate} 次`);

  // ---- start() 把 origin 重置回 dictation ----
  const i = mk();
  await i.m.openPhrases();
  await i.m.usePhrase();
  check('用例前置：此时 origin=phrase', i.m.getSnapshot().origin === 'phrase');
  await i.m.toggle(); // dismiss → idle
  await i.m.start();
  check('start() 重置 origin=dictation',
    i.m.getSnapshot().origin === 'dictation', i.m.getSnapshot().origin);

  // ---- phrases 态不建会话、不入音频队列（不产生识别费用）----
  // 断言必须落在**会话数量**上。原先写的「state 仍是 phrases」是个恒真断言：
  // onAudioFrame 就算不早退，state 也不会变，那条断言永远绿、什么也没测。
  // mk() 每次都会把 FakeSession.all 清空，所以这里的 0 是真实的。
  const j = mk();
  await j.m.openPhrases();
  check('phrases 态不建 ASR 会话（没有会话就没有识别费用）',
    FakeSession.all.length === 0, `${FakeSession.all.length} 个会话`);
  j.m.onAudioFrame({ seq: 1, cumSamples: 1600 }, Buffer.alloc(3200));
  check('phrases 态收到音频帧也不建会话、不抛',
    FakeSession.all.length === 0 && j.m.state === 'phrases',
    `${FakeSession.all.length} 个会话 / ${j.m.state}`);
}

export async function runMachineSelftest() {
  console.log('=== 状态机与背压自测 ===');

  await testNormalFlow();
  await testCancelDuringWarming();
  await testDrainingTruncated();
  await testThrottlingRetry();
  await testNonRetryableError();
  await testBackpressure();
  await testBarFocusable();
  await testCaptureTarget();
  await testPhrases();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`  FAIL ${f.name} ${f.detail}`);
  }
  return { ok: failed.length === 0, failed: failed.length, total: results.length };
}
