import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  BYTE_RATE_TOLERANCE_PCT,
  BATCH_MS,
  CaptureEngine,
  CaptureMetrics,
  EXPECTED_BATCH_SAMPLES,
  EXPECTED_BYTES_PER_SEC,
  OUTPUT_RATE,
  encodeWav16k,
} from '../audio/capture';

/**
 * M1 采集 spike 诊断面板（PRD §5.2 第 6 条）。
 *
 * 这是一个**测量工具**，不是产品界面：把真机上采集链路的关键读数摊在桌面上，
 * 让「Windows 正常、macOS 异常」从一句体验描述变成可判定的数字。
 *
 * 判定口径（写在这里，好让两台机器用同一把尺子）：
 *   字节率      32000 B/s，偏差 >±2% 判不合格 —— PRD §5.2 第 3 条
 *   图时钟速率  1.000000，偏差 >±0.001（千分之一）判不合格 —— macOS 头号嫌疑
 *   批处理滞后  相对起始值变化 >±200ms 判不合格。固定值只是图延迟，无害
 *
 * 判定一律用**速率**，不用累计值：累计值含启动常量，Windows 实测那个常量就有
 * 32ms，足以把真实速率差完全淹没。累计的三项仍然显示，但只标「参考」。
 *
 * 未覆盖：PRD §5.2 第 5 条的背压。它应对的是 ws.bufferedAmount 堆积，
 * 而 M1 还没有 WebSocket，无从测量 —— 留到 M2 接 ASR 时一并做。
 */

const TOLERANCE = {
  byteRatePct: BYTE_RATE_TOLERANCE_PCT,
  graphRate: 0.001,
  lagMs: 200,
};

type Verdict = 'ok' | 'bad' | 'unknown';

function verdict(ok: boolean, started: boolean): Verdict {
  if (!started) return 'unknown';
  return ok ? 'ok' : 'bad';
}

const COLORS: Record<Verdict, string> = {
  ok: '#22c55e',
  bad: '#ef4444',
  unknown: '#8b93a7',
};

export default function DiagPanel() {
  const [metrics, setMetrics] = useState<CaptureMetrics | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [savedPath, setSavedPath] = useState('');
  const engineRef = useRef<CaptureEngine | null>(null);
  const latestRef = useRef<CaptureMetrics | null>(null);

  // 引擎每 200ms 回推一次读数，直接进 state 触发重渲染即可：
  // 10fps 的更新频率对 React 毫无压力，不需要额外做节流。
  useEffect(() => {
    if (engineRef.current) return;
    engineRef.current = new CaptureEngine((m) => {
      latestRef.current = m;
      setMetrics(m);
    });
  }, []);

  /**
   * 自动跑：`#diag?autorun=毫秒数`
   * 起来就采集，到点自动停止、导出 WAV、把结果 JSON 打到终端。
   *
   * 存在的理由只有一个：**两台机器必须用完全相同的流程测量**。
   * 手工点的按钮，时长、停止时机、当时在干什么都不一样，Windows 与 macOS
   * 的数据就没法对比 —— 而对比正是 M1 的全部目的。
   * 这些指标（采样率/字节率/时钟漂移）不需要说话，静音跑同样成立。
   */
  useEffect(() => {
    const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
    const ms = Number(params.get('autorun'));
    if (!Number.isFinite(ms) || ms <= 0) return;

    void start();
    const timer = setTimeout(() => void stopAndSave(), ms);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时跑一次
  }, []);

  const start = useCallback(async () => {
    setError('');
    setSavedPath('');
    try {
      await engineRef.current?.start();
      setRunning(true);
    } catch (e) {
      // 最常见的失败是麦克风权限被拒 / 被别的程序独占。
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      setError(msg);
      // 同时打进终端：自动跑模式下没人看界面，失败必须是可见的。
      console.error(`[采集失败] ${msg}`);
    }
  }, []);

  const stopAndSave = useCallback(async () => {
    const pcm = await engineRef.current?.stop();
    setRunning(false);
    if (!pcm || pcm.length === 0) return;

    const wav = encodeWav16k(pcm);
    const path = await window.voicepilot.saveWav(new Uint8Array(wav));
    setSavedPath(path);

    // 打进终端（开发模式下主进程会转发渲染进程 console），便于直接抄进 PRD。
    console.log(
      `[M1] ${JSON.stringify({ platform: window.voicepilot.platform, wav: path, metrics: latestRef.current })}`
    );
  }, []);

  const started = (metrics?.totalSamples ?? 0) > 0;
  const d = metrics?.device;

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.h1}>
          采集诊断 <span style={styles.sub}>M1 spike · PRD §5.2 第 6 条</span>
        </h1>
        {/* 托盘图标是空图，点不到菜单里的「退出」，这里是唯一的退出口子 */}
        <button style={styles.button(false)} onClick={() => window.voicepilot.quit()}>
          退出应用
        </button>
      </div>

      <div style={styles.bar}>
        <button style={styles.button(running)} onClick={running ? stopAndSave : start}>
          {running ? '停止并导出 WAV' : '开始采集'}
        </button>
        <span style={styles.hint}>
          {running
            ? '对着麦克风持续说话，跑满 3 分钟再看漂移（短时间看不出时钟差异）'
            : `导出的是 16kHz/16bit/单声道 WAV，可直接 npm run probe -- --audio <路径>`}
        </span>
      </div>

      {error && <div style={styles.error}>采集失败：{error}</div>}
      {savedPath && (
        <div style={styles.saved}>
          已导出 {savedPath}
          <button style={styles.link} onClick={() => window.voicepilot.revealPath(savedPath)}>
            在资源管理器中显示
          </button>
        </div>
      )}

      <Section title="时钟与重采样（决定「会不会越说越滞后」）">
        <Row
          label="AudioContext 采样率"
          value={metrics ? `${metrics.nativeSampleRate} Hz` : '—'}
          note="不指定 sampleRate，由系统决定"
        />
        <Row
          label="重采样比"
          value={metrics ? metrics.ratio.toFixed(5) : '—'}
          note="必须是小数。整数 = 老 demo 的 Math.round bug"
        />
        <Row
          label="输出字节率"
          value={metrics ? `${Math.round(metrics.bytesPerSec).toLocaleString()} B/s` : '—'}
          note={`滑动 1 秒。期望 ${EXPECTED_BYTES_PER_SEC.toLocaleString()} B/s ±${TOLERANCE.byteRatePct}%`}
          verdict={verdict(
            Math.abs(metrics?.bytesPerSecDevPct ?? 99) <= TOLERANCE.byteRatePct,
            started
          )}
          detail={metrics ? `偏差 ${metrics.bytesPerSecDevPct.toFixed(2)}%` : ''}
        />
        <Row
          label="图时钟速率"
          value={metrics ? metrics.graphRate.toFixed(6) : '—'}
          note={`滑动 3 秒。期望 1.000000 ±${TOLERANCE.graphRate}。macOS 双时钟不同源的头号嫌疑`}
          verdict={verdict(
            Math.abs((metrics?.graphRate ?? 0) - 1) <= TOLERANCE.graphRate,
            started
          )}
          detail={
            metrics && Number.isFinite(metrics.graphRateMin)
              ? `区间 ${metrics.graphRateMin.toFixed(6)} ~ ${metrics.graphRateMax.toFixed(6)}`
              : ''
          }
        />
        {/*
          这一行决定上面那个时钟偏移算不算问题：
          掉帧 > 0 说明渲染线程没赶上截止时间，音频里有空洞，ASR 会漏字 —— 是缺陷。
          掉帧 = 0 说明只是设备时钟与系统时钟不同源，音频被整体拉伸了千分之几，
          人耳听不出、ASR 也不敏感 —— 无害，不必修。
        */}
        <Row
          label="掉帧（音频空洞）"
          value={metrics && started ? `${metrics.glitches} 次` : '—'}
          note={
            metrics && started
              ? `缺失音频 ${metrics.lostMs.toFixed(0)} ms。>0 即缺陷，=0 则时钟偏移无害`
              : 'worklet 靠 currentFrame 跳变检测'
          }
          verdict={verdict((metrics?.glitches ?? 0) === 0, started)}
        />
        <Row
          label="批处理滞后变化"
          value={metrics && started ? `${metrics.lagDriftMs.toFixed(0)} ms` : '—'}
          note={`当前 ${(metrics?.lagMs ?? 0).toFixed(0)}ms。增长 = 主线程追不上实时`}
          verdict={verdict(Math.abs(metrics?.lagDriftMs ?? 999) <= TOLERANCE.lagMs, started)}
        />
      </Section>

      <Section title="累计偏差（参考，不用于判定 —— 含启动常量）">
        <Row
          label="产出 − 墙钟"
          value={metrics ? `${metrics.driftMs.toFixed(0)} ms` : '—'}
          note="看趋势是否单调增长；绝对值里含第一批攒批的常量"
        />
        <Row
          label="图时钟 − 墙钟"
          value={metrics ? `${metrics.graphDriftMs.toFixed(0)} ms` : '—'}
          note="含「resume 返回到图真正开跑」的启动延迟，Windows 实测约 32ms"
        />
      </Section>

      <Section title="批量与规模">
        <Row
          label="批大小"
          value={metrics && started ? `${metrics.avgBatchSamples.toFixed(1)} 样本` : '—'}
          note={`期望 ${EXPECTED_BATCH_SAMPLES}（${BATCH_MS}ms × ${OUTPUT_RATE}Hz）`}
        />
        <Row
          label="批频率"
          value={metrics ? `${metrics.batchesPerSec.toFixed(1)} 批/秒` : '—'}
          note={`期望 ${1000 / BATCH_MS}。老 demo 是每 8ms 一包，约 125 包/秒`}
        />
        <Row
          label="已采集"
          value={metrics ? `${(metrics.elapsedMs / 1000).toFixed(1)} s` : '—'}
          note={metrics ? `${metrics.totalSamples.toLocaleString()} 样本` : ''}
        />
        <Row
          label="图延迟"
          value={metrics ? `${metrics.baseLatencyMs.toFixed(1)} ms` : '—'}
          note={metrics ? `输出延迟 ${metrics.outputLatencyMs.toFixed(1)} ms` : ''}
        />
      </Section>

      <Section title="输入设备">
        {started && d ? (
          <>
            <Row label="设备" value={d.label || '(未命名)'} />
            <Row label="设备采样率" value={`${d.deviceSampleRate} Hz`} note="getSettings 实际值" />
            <Row label="声道" value={String(d.channels)} />
            {/* 这三项必须为 false。浏览器可以忽略约束，这里看的是实际生效值。 */}
            <Row
              label="系统处理"
              value={[d.echoCancellation && 'AEC', d.noiseSuppression && 'NS', d.autoGainControl && 'AGC']
                .filter(Boolean)
                .join(' / ') || '已全部关闭'}
              note="请求的是全关，此处为实际生效值。ASR 要原始音频"
              verdict={verdict(
                !d.echoCancellation && !d.noiseSuppression && !d.autoGainControl,
                started
              )}
            />
          </>
        ) : (
          <div style={styles.hint}>开始采集后显示</div>
        )}
      </Section>

      <button style={styles.button(false)} onClick={() => copyResult(metrics)}>
        复制结果 JSON
      </button>
      <span style={styles.hint}> 贴进 PRD §5.2 的实测表</span>
    </div>
  );
}

function copyResult(m: CaptureMetrics | null) {
  if (!m) return;
  void navigator.clipboard.writeText(
    JSON.stringify(
      { platform: window.voicepilot.platform, at: new Date().toISOString(), metrics: m },
      null,
      2
    )
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={styles.section}>
      <h2 style={styles.h2}>{title}</h2>
      {children}
    </section>
  );
}

function Row({
  label,
  value,
  note,
  detail,
  verdict: v = 'unknown',
}: {
  label: string;
  value: string;
  note?: string;
  detail?: string;
  verdict?: Verdict;
}) {
  return (
    <div style={styles.row}>
      <div style={styles.rowLabel}>{label}</div>
      <div style={{ ...styles.rowValue, color: COLORS[v] }}>{value}</div>
      <div style={styles.rowNote}>{detail ? `${detail} · ${note ?? ''}` : (note ?? '')}</div>
    </div>
  );
}

const styles = {
  page: {
    maxWidth: 860,
    margin: '0 auto',
    padding: '28px 32px 60px',
    fontSize: 13,
    lineHeight: 1.7,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
  },
  h1: { fontSize: 18, fontWeight: 600, margin: '0 0 4px', color: '#f3f4f6' },
  sub: { fontSize: 12, fontWeight: 400, color: '#6b7280' },
  h2: {
    fontSize: 12,
    fontWeight: 600,
    color: '#93c5fd',
    margin: '0 0 10px',
    letterSpacing: 0.5,
  },
  bar: { display: 'flex', alignItems: 'center', gap: 12, margin: '18px 0 20px' },
  section: {
    border: '1px solid #262b36',
    borderRadius: 10,
    padding: '14px 18px 6px',
    marginBottom: 14,
    background: '#14171f',
  },
  row: {
    display: 'grid',
    gridTemplateColumns: '140px 160px 1fr',
    gap: 12,
    alignItems: 'baseline',
    paddingBottom: 9,
  },
  rowLabel: { color: '#8b93a7' },
  rowValue: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontWeight: 600 },
  rowNote: { color: '#5b6472', fontSize: 11 },
  button: (running: boolean) => ({
    padding: '7px 16px',
    borderRadius: 7,
    border: `1px solid ${running ? '#7f1d1d' : '#1f4ed8'}`,
    background: running ? '#2a1416' : '#16233f',
    color: '#e5e7eb',
    fontSize: 13,
    cursor: 'pointer' as const,
  }),
  link: {
    marginLeft: 10,
    padding: 0,
    border: 'none',
    background: 'none',
    color: '#93c5fd',
    cursor: 'pointer' as const,
    textDecoration: 'underline',
    fontSize: 12,
  },
  hint: { color: '#6b7280', fontSize: 12 },
  error: {
    color: '#fca5a5',
    background: '#2a1416',
    border: '1px solid #7f1d1d',
    borderRadius: 8,
    padding: '8px 12px',
    marginBottom: 12,
  },
  saved: {
    color: '#86efac',
    background: '#0f2418',
    border: '1px solid #166534',
    borderRadius: 8,
    padding: '8px 12px',
    marginBottom: 12,
    wordBreak: 'break-all' as const,
  },
} satisfies Record<string, CSSProperties | ((running: boolean) => CSSProperties)>;
