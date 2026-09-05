import { useEffect, useState } from 'react';

/**
 * M0 骨架的占位界面。
 *
 * 它不是 UI 设计，而是一个**自检面板**：把「主进程 ↔ preload ↔ 渲染进程」
 * 这条链路上的关键信号直接显示出来，用来确认三件事真的通了 ——
 *   1. contextBridge 正常（能读到 platform / versions）
 *   2. 全局快捷键能穿到渲染进程（toggles 计数会涨）
 *   3. 鼠标穿透能按进出切换（否则按钮点不到）
 *
 * 真正的悬浮条 UI 在 M2 做。
 */
export default function App() {
  const [platform, setPlatform] = useState('');
  const [versions, setVersions] = useState<Window['voicepilot']['versions'] | null>(null);
  const [toggles, setToggles] = useState(0);
  const [hovering, setHovering] = useState(false);

  useEffect(() => {
    const vp = window.voicepilot;
    setPlatform(vp.platform);
    setVersions(vp.versions);
    return vp.onToggle(() => setToggles((n) => n + 1));
  }, []);

  // 移入时关闭穿透（按钮可点），移出时恢复穿透（不挡住下面的应用）
  useEffect(() => {
    window.voicepilot.setMousePassthrough(!hovering);
  }, [hovering]);

  return (
    <div
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={{
        height: '100%',
        boxSizing: 'border-box',
        margin: 8,
        padding: '14px 18px',
        borderRadius: 12,
        background: 'rgba(23, 26, 33, 0.92)',
        border: '1px solid #262b36',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 6,
        fontSize: 12,
        lineHeight: 1.6,
        color: '#8b93a7',
        userSelect: 'none',
      }}
    >
      <div style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 600, letterSpacing: 0.5 }}>
        VoicePilot <span style={{ color: '#93c5fd', fontWeight: 500 }}>闻字</span>
      </div>

      <div>
        平台 <b style={{ color: '#e5e7eb' }}>{platform || '…'}</b>
        {'  ·  '}
        Electron <b style={{ color: '#e5e7eb' }}>{versions?.electron ?? '…'}</b>
        {'  ·  '}
        Chrome <b style={{ color: '#e5e7eb' }}>{versions?.chrome ?? '…'}</b>
      </div>

      <div>
        快捷键触发 <b style={{ color: toggles > 0 ? '#22c55e' : '#e5e7eb' }}>{toggles}</b> 次
        {'  ·  '}
        鼠标穿透 <b style={{ color: hovering ? '#f59e0b' : '#22c55e' }}>{hovering ? '已关闭（可点击）' : '开启（不挡操作）'}</b>
      </div>
    </div>
  );
}
