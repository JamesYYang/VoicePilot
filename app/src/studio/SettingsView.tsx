import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

/**
 * 设置页（F12）—— 目前只有「权限」区块：macOS 辅助功能授权状态 + 分步引导。
 * 被动显示：用户遇到快捷键不生效时主动来看，不做弹窗、不做智能触发。
 */

type PermStatus = { accessibility: boolean | null };

export default function SettingsView({ bridge }: { bridge?: Window['voicepilot'] } = {}) {
  const vp = bridge ?? window.voicepilot;
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

  // accessibility === null 表示「本平台不适用」（Windows）
  const applicable = status?.accessibility != null;
  const granted = status?.accessibility === true;

  return (
    <div style={styles.page}>
      <h2 style={styles.h2}>权限</h2>

      {!applicable ? (
        <p style={styles.plain}>本平台无需额外权限。</p>
      ) : (
        <div style={styles.block}>
          <div style={styles.statusRow}>
            <span style={styles.label}>辅助功能（全局快捷键）</span>
            <span style={{ ...styles.status, color: granted ? '#16a34a' : '#dc2626' }}>
              {granted ? '已授权 ✓' : '未授权 ✗'}
            </span>
          </div>
          <ol style={styles.steps}>
            <li>打开「系统设置」</li>
            <li>进入「隐私与安全性」</li>
            <li>
              点「辅助功能」，勾选 <b>VoicePilot 闻字</b>
            </li>
          </ol>
          <button style={styles.button} onClick={() => void vp.openAccessibilitySettings()}>
            打开系统设置
          </button>
        </div>
      )}
    </div>
  );
}

const styles = {
  page: { padding: 24, color: '#1f2937', fontSize: 13 },
  h2: { margin: '0 0 16px', fontSize: 15, fontWeight: 600, color: '#111827' },
  plain: { margin: 0, color: '#6b7280' },
  block: { display: 'flex', flexDirection: 'column', gap: 12 },
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
