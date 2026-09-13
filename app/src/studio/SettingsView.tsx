import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useT, useLocale } from '../i18n';
import type { Locale } from '../../shared/i18n/index.js';
import { acceleratorFromEvent } from './shortcutKeys';

/**
 * 设置页（F12）—— 语言选择器 + 「权限」区块（macOS 辅助功能授权状态 + 分步引导）。
 * 被动显示：用户遇到快捷键不生效时主动来看，不做弹窗、不做智能触发。
 */

type PermStatus = { accessibility: boolean | null };

export default function SettingsView({ bridge }: { bridge?: Window['voicepilot'] } = {}) {
  const vp = bridge ?? window.voicepilot;
  const t = useT();
  const locale = useLocale();
  const [status, setStatus] = useState<PermStatus | null>(null);
  // 哪个槽位正在录制。两个 ShortcutSetting 各自挂一个捕获阶段 window keydown
  // 监听，若各自持有 recording 就会有两条监听同时生效：先触发的那条把按键写进
  // 自己的槽位，后触发的那条看到同键已被占用、于是报冲突 —— 用户看着「常用语」
  // 那块按的键，结果被写进了主槽位。把「谁在录制」提到这里做互斥：任一槽位在录
  // 时，另一块的录制按钮禁用。
  const [recordingSlot, setRecordingSlot] = useState<'main' | 'phrases' | null>(null);
  // 稳定引用（useCallback），免得每次渲染都换新函数把子组件的录制监听 effect 重挂。
  const startMain = useCallback(() => setRecordingSlot('main'), []);
  const startPhrases = useCallback(() => setRecordingSlot('phrases'), []);
  const stopRecording = useCallback(() => setRecordingSlot(null), []);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const s = await vp.getPermissionStatus();
        if (alive) setStatus(s);
      } catch {
        // 单次失败保留上次状态，下次轮询自愈
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [vp]);

  // status === null 表示「加载中」；status.accessibility === null 表示「本平台不适用」（Windows）
  const loaded = status != null;
  const applicable = status?.accessibility != null;
  const granted = status?.accessibility === true;

  return (
    <div style={styles.page}>
      <h2 style={styles.h2}>{t('settings.language')}</h2>
      <select
        data-testid="settings-lang"
        style={styles.select}
        value={locale}
        onChange={(e) => void vp.setLanguage(e.target.value as Locale)}
      >
        <option value="zh-CN">简体中文</option>
        <option value="zh-TW">繁體中文</option>
        <option value="en-US">English</option>
      </select>

      <h2 style={{ ...styles.h2, marginTop: 16 }}>{t('settings.shortcut')}</h2>
      <ShortcutSetting
        vp={vp}
        slot="main"
        recording={recordingSlot === 'main'}
        disabled={recordingSlot !== null && recordingSlot !== 'main'}
        onStart={startMain}
        onStop={stopRecording}
      />

      <h2 style={{ ...styles.h2, marginTop: 16 }}>{t('settings.phraseShortcut')}</h2>
      <ShortcutSetting
        vp={vp}
        slot="phrases"
        recording={recordingSlot === 'phrases'}
        disabled={recordingSlot !== null && recordingSlot !== 'phrases'}
        onStart={startPhrases}
        onStop={stopRecording}
      />

      <h2 style={{ ...styles.h2, marginTop: 16 }}>{t('settings.permissions')}</h2>

      {!loaded ? null : !applicable ? (
        <p style={styles.plain}>{t('settings.noPermNeeded')}</p>
      ) : (
        <div style={styles.block}>
          <div style={styles.statusRow}>
            <span style={styles.label}>{t('settings.accessibility')}</span>
            <span style={{ ...styles.status, color: granted ? '#16a34a' : '#dc2626' }}>
              {granted ? t('settings.granted') : t('settings.denied')}
            </span>
          </div>
          <ol style={styles.steps}>
            <li>{t('settings.step1')}</li>
            <li>{t('settings.step2')}</li>
            <li>
              {t('settings.step3Prefix')} <b>{t('productName')}</b>
            </li>
          </ol>
          <button style={styles.button} onClick={() => void vp.openAccessibilitySettings()}>
            {t('settings.openSettings')}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 快捷键录制。点击后进入录制态，捕获下一个带修饰键的组合键。
 * 冲突（主进程注册失败）时显示提示且**不更新**界面上的当前键。
 *
 * 两个槽位（main / phrases）共用这套控件：录制期间挂起的是**整个** globalShortcut
 * （setShortcutSuspended 管的是全局开关），两个键一起挂起正是录制时要的行为。
 *
 * `recording` 由父组件按槽位下发（互斥，见 SettingsView 里的 recordingSlot），
 * 本组件不再自己持有录制态 —— 两个实例同时录制会各自消费同一个按键、把键写错槽位。
 */
function ShortcutSetting({
  vp,
  slot,
  recording,
  disabled,
  onStart,
  onStop,
}: {
  vp: Window['voicepilot'];
  slot: 'main' | 'phrases';
  recording: boolean;
  /** 另一个槽位正在录制：本块的录制按钮禁用，避免两条监听同时生效。 */
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const t = useT();
  const [accel, setAccel] = useState('');
  const [error, setError] = useState('');

  const prefix = slot === 'phrases' ? 'settings-phrase-shortcut' : 'settings-shortcut';
  const hintKey = slot === 'phrases' ? 'settings.phraseShortcut.hint' : 'settings.shortcut.hint';
  const read = useCallback(
    () => (slot === 'phrases' ? vp.getPhraseShortcut() : vp.getShortcut()),
    [vp, slot]
  );
  const write = useCallback(
    (next: string) => (slot === 'phrases' ? vp.setPhraseShortcut(next) : vp.setShortcut(next)),
    [vp, slot]
  );

  useEffect(() => {
    let alive = true;
    void read().then((r) => { if (alive) setAccel(r.accel); }).catch(() => {});
    return () => { alive = false; };
  }, [read]);

  // 录制：只在 recording 时监听 keydown。Esc = 取消录制（不提交、直接退出录制态）；
  // 其余无法表达的键不提交，留在录制态等用户重按
  useEffect(() => {
    if (!recording) return;
    const onKey = async (e: KeyboardEvent) => {
      e.preventDefault();
      // Esc 是显式的取消路径：裸 Esc 无修饰键，acceleratorFromEvent 只会返回 null，
      // 若按「无法表达的键」处理会一直留在录制态（全局快捷键也一直被挂起）。
      if (e.key === 'Escape') {
        setError('');
        onStop();
        return;
      }
      const next = acceleratorFromEvent(e);
      if (!next) {
        // 纯修饰键 / 无修饰键 / 媒体键等无法表达的键：不提交，留在录制态让用户重按
        setError(t('settings.shortcut.unsupported'));
        return;
      }
      onStop();
      const r = await write(next).catch(() => ({ ok: false, accel }));
      if (r.ok) { setAccel(r.accel); setError(''); }
      else { setError(t('settings.shortcut.conflict')); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, write, t, accel, onStop]);

  // 录制期间挂起全局快捷键：OS 级快捷键在本应用窗口有焦点时照样触发，
  // preventDefault 拦不住 —— 不挂起的话，用户按下的组合键会被主进程当成
  // 一次听写，同时又被写进绑定。清理函数保证离开录制或组件卸载时一定恢复。
  useEffect(() => {
    if (!recording) return;
    void vp.suspendShortcut(true);
    return () => { void vp.suspendShortcut(false); };
  }, [recording, vp]);

  return (
    <div style={styles.block}>
      <div style={styles.statusRow}>
        <span data-testid={prefix} style={styles.label}>
          {recording ? t('settings.shortcut.recording') : accel}
        </span>
        <button
          data-testid={`${prefix}-record`}
          style={styles.button}
          disabled={disabled}
          onClick={() => { setError(''); onStart(); }}
        >
          {t('settings.shortcut.record')}
        </button>
      </div>
      {error && <span style={{ color: '#dc2626' }}>{error}</span>}
      <span style={styles.plain}>{t(hintKey)}</span>
    </div>
  );
}

const styles = {
  page: { padding: 24, color: '#1f2937', fontSize: 13 },
  h2: { margin: '0 0 16px', fontSize: 15, fontWeight: 600, color: '#111827' },
  plain: { margin: 0, color: '#6b7280' },
  block: { display: 'flex', flexDirection: 'column', gap: 12 },
  select: {
    alignSelf: 'flex-start',
    padding: '4px 8px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    background: '#ffffff',
    color: '#111827',
    fontSize: 12,
    outline: 'none',
  },
  statusRow: { display: 'flex', alignItems: 'center', gap: 12 },
  label: { color: '#374151' },
  status: { fontWeight: 600 },
  steps: { margin: 0, paddingLeft: 20, color: '#374151', lineHeight: 1.8 },
  button: {
    alignSelf: 'flex-start',
    padding: '8px 20px',
    borderRadius: 8,
    border: 'none',
    background: '#2563eb',
    color: '#fff',
    fontSize: 13,
    cursor: 'pointer',
  },
} satisfies Record<string, CSSProperties>;
