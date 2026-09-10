import type { CSSProperties } from 'react';
import { useT } from '../i18n';

/**
 * 首次使用欢迎页（F8）。不提问，只介绍快捷键与权限，点「开始使用」关窗。
 * 「已看过」标记（first_run_done）由主进程在窗口关闭时写入（见 onboarding.js）。
 */
export default function Onboarding({ bridge }: { bridge?: Window['voicepilot'] } = {}) {
  const vp = bridge ?? window.voicepilot;
  const t = useT();
  const isMac = navigator.userAgent.includes('Mac');
  const shortcut = isMac ? '⌥Space' : 'Ctrl+Shift+Space';
  const permission = isMac ? t('onboarding.permissionMac') : t('onboarding.permissionWin');

  return (
    <div style={styles.page}>
      <h1 style={styles.title}>{t('onboarding.titlePrefix')} <span style={styles.brand}>{t('productName')}</span></h1>
      <p style={styles.line}>
        {t('onboarding.intro', { shortcut })}
      </p>
      <p style={styles.hint}>{permission}</p>
      <button style={styles.primary} onClick={() => void vp.closeOnboarding()}>
        {t('onboarding.start')}
      </button>
    </div>
  );
}

const styles = {
  page: { height: '100vh', boxSizing: 'border-box', padding: 24, display: 'flex', flexDirection: 'column', gap: 14, background: '#ffffff', color: '#1f2937', fontSize: 13 },
  title: { margin: 0, fontSize: 16, fontWeight: 600 },
  brand: { color: '#2563eb', fontWeight: 700 },
  line: { margin: 0, lineHeight: 1.6 },
  key: { fontFamily: 'monospace', background: '#f3f4f6', padding: '2px 6px', borderRadius: 4 },
  hint: { margin: 0, color: '#6b7280', fontSize: 12, lineHeight: 1.6 },
  primary: { alignSelf: 'flex-start', padding: '8px 20px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontSize: 13, cursor: 'pointer' },
} satisfies Record<string, CSSProperties>;
