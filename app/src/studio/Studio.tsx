import { useState } from 'react';
import type { CSSProperties } from 'react';
import PolishView from './PolishView';
import HistoryView from './HistoryView';

/**
 * 主应用（Studio）外壳 —— 润色工作区的骨架（Task 3）。
 *
 * 布局分两块：左侧 48px 图标栏 + 右侧内容区。
 * 图标栏只有三个入口：润色 / 历史 / 设置。其中「润色」是主工作区，对应
 * Task 4 的 PolishView（当前先用占位 div 顶着）；「历史」「设置」点了只显示
 * 「待实现」占位，后续任务再填。
 *
 * 亮色样式（spec §2）：白底、深色文字，与悬浮条的暗色浮层区分开。
 */

type View = 'polish' | 'history' | 'settings';

const NAV: { key: View; label: string }[] = [
  { key: 'polish', label: '润色' },
  { key: 'history', label: '历史' },
  { key: 'settings', label: '设置' },
];

export default function Studio({ bridge }: { bridge?: Window['voicepilot'] } = {}) {
  const [view, setView] = useState<View>('polish');

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
          <div style={styles.placeholder}>待实现</div>
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
  placeholder: {
    margin: 'auto',
    color: '#9ca3af',
  },
} satisfies Record<string, CSSProperties | ((active: boolean) => CSSProperties)>;
