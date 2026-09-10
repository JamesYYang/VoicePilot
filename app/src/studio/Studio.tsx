import { useState } from 'react';
import type { CSSProperties } from 'react';
import PolishView from './PolishView';
import HistoryView from './HistoryView';
import SettingsView from './SettingsView';
import { useT } from '../i18n';

/**
 * 主应用（Studio）外壳 —— 润色工作区的骨架（Task 3）。
 *
 * 布局分两块：左侧 48px 图标栏 + 右侧内容区。
 * 图标栏只有三个入口：润色 / 历史 / 设置，分别渲染
 * PolishView / HistoryView / SettingsView。
 *
 * 亮色样式（spec §2）：白底、深色文字，与悬浮条的暗色浮层区分开。
 */

type View = 'polish' | 'history' | 'settings';

export default function Studio({ bridge }: { bridge?: Window['voicepilot'] } = {}) {
  const t = useT();
  const [view, setView] = useState<View>('polish');

  const NAV: { key: View; label: string }[] = [
    { key: 'polish', label: t('studio.polish') },
    { key: 'history', label: t('studio.history') },
    { key: 'settings', label: t('studio.settings') },
  ];

  return (
    <div style={styles.page}>
      <aside style={styles.rail}>
        {NAV.map(({ key, label }) => (
          <button
            key={key}
            style={styles.railButton(view === key)}
            onClick={() => setView(key)}
          >
            {label}
          </button>
        ))}
      </aside>

      <main style={styles.content}>
        {view === 'polish' ? (
          <PolishView bridge={bridge} />
        ) : view === 'history' ? (
          <HistoryView bridge={bridge} />
        ) : (
          <SettingsView bridge={bridge} />
        )}
      </main>
    </div>
  );
}

const styles = {
  page: {
    display: 'flex',
    height: '100vh',
    background: '#ffffff',
    color: '#1f2937',
    fontSize: 13,
  },
  rail: {
    width: 48,
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 4,
    padding: '12px 6px',
    boxSizing: 'border-box',
    background: '#f3f4f6',
    borderRight: '1px solid #e5e7eb',
  },
  railButton: (active: boolean) => ({
    padding: '8px 0',
    borderRadius: 6,
    border: 'none',
    background: active ? '#ffffff' : 'transparent',
    color: active ? '#111827' : '#6b7280',
    fontSize: 12,
    fontWeight: active ? 600 : 400,
    cursor: 'pointer',
    boxShadow: active ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
  }),
  content: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
  },
} satisfies Record<string, CSSProperties | ((active: boolean) => CSSProperties)>;
