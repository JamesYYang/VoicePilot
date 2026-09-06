import { SessionMachine } from '../session/machine.js';
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

export async function runMachineSelftest() {
  console.log('=== 状态机与背压自测 ===');

  await testNormalFlow();
  await testCancelDuringWarming();
  await testDrainingTruncated();
  await testThrottlingRetry();
  await testNonRetryableError();
  await testBackpressure();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`  FAIL ${f.name} ${f.detail}`);
  }
  return { ok: failed.length === 0, failed: failed.length, total: results.length };
}
