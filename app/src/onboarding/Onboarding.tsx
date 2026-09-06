import type { CSSProperties } from 'react';

/**
 * 首次使用引导页（F8）。只问一个问题，选择即落盘并关窗。
 * ASR 词表本期留空（等 F11 下发），这里只记职业 + 场景默认值。
 */

const OPTIONS = [
  { key: 'general', label: '通用', hint: '不加载词表，通用口述' },
  { key: 'product_rd', label: '产品与研发', hint: '场景默认「文档」' },
  { key: 'other', label: '其他', hint: '不加载词表，可在设置中自定义' },
] as const;

export default function Onboarding({ bridge }: { bridge?: Window['voicepilot'] } = {}) {
  const vp = bridge ?? window.voicepilot;

  const choose = async (profession: string) => {
    try {
      await vp.saveOnboarding({ profession });
    } finally {
      await vp.closeOnboarding();
    }
  };

  return (
    <div style={styles.page}>
      <h1 style={styles.title}>欢迎使用 VoicePilot 闻字</h1>
      <p style={styles.question}>你的工作主要涉及哪个领域？</p>
      <div style={styles.options}>
        {OPTIONS.map((o) => (
          <button key={o.key} style={styles.option} onClick={() => void choose(o.key)}>
            <span style={styles.optionLabel}>{o.label}</span>
            <span style={styles.optionHint}>{o.hint}</span>
          </button>
        ))}
      </div>
      <button style={styles.skip} onClick={() => void choose('general')}>
        跳过（默认通用）
      </button>
    </div>
  );
}

const styles = {
  page: { height: '100vh', boxSizing: 'border-box', padding: 24, display: 'flex', flexDirection: 'column', gap: 12, background: '#ffffff', color: '#1f2937', fontSize: 13 },
  title: { margin: 0, fontSize: 16, fontWeight: 600 },
  question: { margin: 0, color: '#6b7280' },
  options: { display: 'flex', flexDirection: 'column', gap: 8 },
  option: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, padding: '10px 12px', borderRadius: 8, border: '1px solid #d1d5db', background: '#ffffff', cursor: 'pointer', textAlign: 'left' },
  optionLabel: { fontSize: 13, fontWeight: 600, color: '#111827' },
  optionHint: { fontSize: 12, color: '#6b7280' },
  skip: { border: 'none', background: 'transparent', color: '#6b7280', fontSize: 12, cursor: 'pointer', textAlign: 'left', padding: 0 },
} satisfies Record<string, CSSProperties>;
