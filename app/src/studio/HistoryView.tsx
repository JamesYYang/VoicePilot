import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useT } from '../i18n';

/**
 * 历史浏览（F6，本期只浏览不搜索）。
 *
 * 列表倒序显示每条的时间与原文片段；点开看全文，可复制、可「润色」带回工作区。
 * 「润色」复用 vp.openStudio，把该条原文 + historyId 交给主应用 —— 采用润色结果时
 * 才能回写同一条历史（vp:polish/adopt 按 pendingHistoryId 更新）。
 */

function fmtTime(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function HistoryView({ bridge }: { bridge?: Window['voicepilot'] } = {}) {
  const vp = bridge ?? window.voicepilot;
  const t = useT();
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [selected, setSelected] = useState<HistoryRow | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void vp.historyList().then(setRows);
  }, [vp]);

  const open = (r: HistoryRow) => {
    setSelected(r);
    setCopied(false);
  };

  return (
    <div style={styles.page}>
      <aside style={styles.list}>
        {rows.length === 0 && <div style={styles.empty}>{t('history.empty')}</div>}
        {rows.map((r) => (
          <button key={r.id} style={styles.item(selected?.id === r.id)} onClick={() => open(r)}>
            <div style={styles.itemTime}>{fmtTime(r.created_at)}</div>
            <div style={styles.itemText}>{r.text.slice(0, 40)}</div>
            {(r.scene || r.tone) && (
              <div style={styles.tags}>
                {r.scene && <span style={styles.tag}>{r.scene}</span>}
                {r.tone && <span style={styles.tag}>{r.tone}</span>}
              </div>
            )}
            {r.polished && <span style={styles.polishedTag}>{t('history.polished')}</span>}
          </button>
        ))}
      </aside>

      <main style={styles.detail}>
        {selected ? (
          <>
            <div style={styles.detailMeta}>
              {fmtTime(selected.created_at)}
              {selected.duration_ms != null && ` · ${Math.round(selected.duration_ms / 1000)} ${t('history.seconds')}`}
            </div>
            <pre style={styles.body}>{selected.text}</pre>
            {selected.polished && (
              <>
                <div style={styles.detailLabel}>{t('history.result')}</div>
                <pre style={styles.body}>{selected.polished}</pre>
              </>
            )}
            <div style={styles.actions}>
              <button
                style={styles.primary}
                onClick={() => {
                  void vp.copy(selected.polished ?? selected.text).then((ok) => setCopied(ok));
                }}
              >
                {t('history.copy')}
              </button>
              <button
                style={styles.ghost}
                onClick={() => void vp.openStudio({ text: selected.text, historyId: selected.id })}
              >
                {t('history.polish')}
              </button>
              {copied && <span style={styles.hint}>{t('history.copied')}</span>}
            </div>
          </>
        ) : (
          <div style={styles.empty}>{t('history.selectHint')}</div>
        )}
      </main>
    </div>
  );
}

const styles = {
  page: { flex: 1, minHeight: 0, display: 'flex', background: '#ffffff', color: '#1f2937', fontSize: 13 },
  list: { width: 240, flexShrink: 0, overflowY: 'auto', borderRight: '1px solid #e5e7eb', padding: 8, boxSizing: 'border-box' },
  empty: { margin: 'auto', color: '#9ca3af', padding: 16 },
  item: (active: boolean) => ({
    display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', marginBottom: 4,
    borderRadius: 6, border: 'none', cursor: 'pointer',
    background: active ? '#eff6ff' : 'transparent', color: '#1f2937', fontSize: 12,
  }),
  itemTime: { color: '#9ca3af', fontSize: 11 },
  itemText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  tags: { display: 'flex', gap: 4, marginTop: 4 },
  tag: { padding: '1px 6px', borderRadius: 4, background: '#f3f4f6', color: '#6b7280', fontSize: 11 },
  polishedTag: { marginLeft: 4, color: '#1d4ed8', fontSize: 11 },
  detail: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', padding: 16, gap: 10, boxSizing: 'border-box' },
  detailMeta: { color: '#9ca3af', fontSize: 12, flexShrink: 0 },
  detailLabel: { color: '#6b7280', fontSize: 12, flexShrink: 0 },
  body: { flex: 1, minHeight: 0, margin: 0, padding: 12, borderRadius: 8, border: '1px solid #e5e7eb', background: '#fafafa', overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.6 },
  actions: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  primary: { padding: '5px 14px', borderRadius: 6, border: '1px solid #1d4ed8', background: '#1d4ed8', color: '#ffffff', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  ghost: { padding: '5px 14px', borderRadius: 6, border: '1px solid #d1d5db', background: '#ffffff', color: '#111827', fontSize: 12, cursor: 'pointer' },
  hint: { color: '#6b7280', fontSize: 11 },
} satisfies Record<string, CSSProperties | ((active: boolean) => CSSProperties)>;
