import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useT } from '../i18n';

/**
 * 「设置 API Key」页。启动时无凭据则弹出。
 *
 * 只收集两个字段：API Key（敏感，密码框）+ 工作空间 ID。保存走 vp.saveKey，
 * 由主进程 safeStorage 加密落盘。保存成功后关窗。
 */

export default function KeyEntry({ bridge }: { bridge?: Window['voicepilot'] } = {}) {
  const vp = bridge ?? window.voicepilot;
  const t = useT();
  const [apiKey, setApiKey] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!apiKey.trim() || !workspaceId.trim()) {
      setError(t('key.emptyError'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await vp.saveKey({ apiKey: apiKey.trim(), workspaceId: workspaceId.trim() });
      await vp.closeKeyEntry();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <div style={styles.page}>
      <h1 style={styles.title}>{t('key.title')}</h1>
      <p style={styles.hint}>{t('key.hint')}</p>

      <label style={styles.field}>
        <span style={styles.label}>{t('key.apiKey')}</span>
        <input
          type="password"
          style={styles.input}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-…"
        />
      </label>

      <label style={styles.field}>
        <span style={styles.label}>{t('key.workspaceId')}</span>
        <input
          style={styles.input}
          value={workspaceId}
          onChange={(e) => setWorkspaceId(e.target.value)}
          placeholder={t('key.wsPlaceholder')}
        />
      </label>

      {error && <div style={styles.error}>{error}</div>}

      <button style={styles.save} onClick={() => void save()} disabled={saving}>
        {saving ? t('key.saving') : t('key.save')}
      </button>
    </div>
  );
}

const styles = {
  page: {
    height: '100vh',
    boxSizing: 'border-box',
    padding: 24,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    background: '#ffffff',
    color: '#1f2937',
    fontSize: 13,
  },
  title: { margin: 0, fontSize: 16, fontWeight: 600 },
  hint: { margin: 0, color: '#6b7280' },
  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { color: '#6b7280', fontSize: 12 },
  input: {
    padding: '8px 10px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    fontSize: 13,
    outline: 'none',
    background: '#ffffff',
    color: '#111827',
  },
  error: { color: '#dc2626', fontSize: 12 },
  save: {
    marginTop: 4,
    padding: '8px 0',
    borderRadius: 6,
    border: '1px solid #1d4ed8',
    background: '#1d4ed8',
    color: '#ffffff',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
} satisfies Record<string, CSSProperties>;
