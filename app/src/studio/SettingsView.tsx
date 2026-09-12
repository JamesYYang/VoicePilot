import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useT, useLocale } from '../i18n';
import type { Locale } from '../../shared/i18n/index.js';

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
      <ShortcutSetting vp={vp} />

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
 */
function ShortcutSetting({ vp }: { vp: Window['voicepilot'] }) {
  const t = useT();
  const [accel, setAccel] = useState('');
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void vp.getShortcut().then((r) => { if (alive) setAccel(r.accel); }).catch(() => {});
    return () => { alive = false; };
  }, [vp]);

  // 录制：只在 recording 时监听 keydown；忽略纯修饰键本身
  useEffect(() => {
    if (!recording) return;
    const onKey = async (e: KeyboardEvent) => {
      e.preventDefault();
      const mods: string[] = [];
      if (e.ctrlKey) mods.push('Ctrl');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');
      if (e.metaKey) mods.push('Super');
      const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      const isModifierOnly = ['Control', 'Alt', 'Shift', 'Meta'].includes(e.key);
      if (isModifierOnly || mods.length === 0) return;
      const next = [...mods, key].join('+');
      setRecording(false);
      const r = await vp.setShortcut(next).catch(() => ({ ok: false, accel }));
      if (r.ok) { setAccel(r.accel); setError(''); }
      else { setError(t('settings.shortcut.conflict')); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, vp, t, accel]);

  return (
    <div style={styles.block}>
      <div style={styles.statusRow}>
        <span data-testid="settings-shortcut" style={styles.label}>
          {recording ? t('settings.shortcut.recording') : accel}
        </span>
        <button
          data-testid="settings-shortcut-record"
          style={styles.button}
          onClick={() => { setError(''); setRecording(true); }}
        >
          {t('settings.shortcut.record')}
        </button>
      </div>
      {error && <span style={{ color: '#dc2626' }}>{error}</span>}
      <span style={styles.plain}>{t('settings.shortcut.hint')}</span>
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
