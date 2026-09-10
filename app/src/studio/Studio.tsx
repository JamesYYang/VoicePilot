import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
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

/** 左侧菜单图标（16 视口、1.5 stroke、currentColor，随文字变色）。 */
const ICONS: Record<View, ReactNode> = {
  polish: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2l1.2 3.5 3.5 1.2-3.5 1.2L8 11.4 6.8 7.9 3.3 6.7 6.8 5.5z" />
    </svg>
  ),
  history: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3l2 1.5" />
    </svg>
  ),
  settings: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" />
    </svg>
  ),
};

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
            <span style={styles.railIcon}>{ICONS[key]}</span>
            <span>{label}</span>
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
    width: 'auto',
    minWidth: 48,
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 4,
    padding: '12px 8px',
    boxSizing: 'border-box',
    background: '#f3f4f6',
    borderRight: '1px solid #e5e7eb',
  },
  railButton: (active: boolean) => ({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '8px 0',
    whiteSpace: 'nowrap',
    borderRadius: 6,
    border: 'none',
    background: active ? '#ffffff' : 'transparent',
    color: active ? '#111827' : '#6b7280',
    fontSize: 12,
    fontWeight: active ? 600 : 400,
    cursor: 'pointer',
    boxShadow: active ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
  }),
  railIcon: { display: 'flex', flexShrink: 0 },
  content: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
  },
} satisfies Record<string, CSSProperties | ((active: boolean) => CSSProperties)>;
