import type { CSSProperties } from 'react';

/**
 * 首次使用欢迎页（F8）。不提问，只介绍快捷键与权限，点「开始使用」关窗。
 * 「已看过」标记（first_run_done）由主进程在窗口关闭时写入（见 onboarding.js）。
 */
export default function Onboarding({ bridge }: { bridge?: Window['voicepilot'] } = {}) {
  const vp = bridge ?? window.voicepilot;
  const isMac = navigator.userAgent.includes('Mac');
  const shortcut = isMac ? '⌥Space' : 'Ctrl+Shift+Space';
  const permission = isMac
    ? '请在系统设置中允许「麦克风」权限，并在「隐私与安全性 → 辅助功能」中允许 VoicePilot（全局快捷键需要）。'
    : '首次使用请在系统设置中允许「麦克风」权限。';

  return (
    <div style={styles.page}>
      <h1 style={styles.title}>欢迎使用 VoicePilot 闻字</h1>
      <p style={styles.line}>
        按 <b style={styles.key}>{shortcut}</b> 开始语音输入，说完自动生成文字，可一键复制或润色。
      </p>
      <p style={styles.hint}>{permission}</p>
      <button style={styles.primary} onClick={() => void vp.closeOnboarding()}>
        开始使用
      </button>
    </div>
  );
}

const styles = {
  page: { height: '100vh', boxSizing: 'border-box', padding: 24, display: 'flex', flexDirection: 'column', gap: 14, background: '#ffffff', color: '#1f2937', fontSize: 13 },
  title: { margin: 0, fontSize: 16, fontWeight: 600 },
  line: { margin: 0, lineHeight: 1.6 },
  key: { fontFamily: 'monospace', background: '#f3f4f6', padding: '2px 6px', borderRadius: 4 },
  hint: { margin: 0, color: '#6b7280', fontSize: 12, lineHeight: 1.6 },
  primary: { alignSelf: 'flex-start', padding: '8px 20px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontSize: 13, cursor: 'pointer' },
} satisfies Record<string, CSSProperties>;
