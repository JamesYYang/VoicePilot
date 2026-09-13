import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useT } from '../i18n';

/**
 * 常用语管理（F16）。与 HistoryView 结构对称，但**不复用它** —— 那边是只读 +
 * 复制/润色，这边是编辑/删除/新建，硬塞会让两边都变形。
 *
 * 详情面板同时承担「新建」：没有选中项时点保存就是新增（同一个 vp.phrasesSave）。
 * 这比刻意禁止新建更省事，也让手写一条常用语成为可能。
 */
export default function PhrasesView({ bridge }: { bridge?: Window['voicepilot'] } = {}) {
  const vp = bridge ?? window.voicepilot;
  const t = useT();
  const [rows, setRows] = useState<PhraseRow[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void vp.phrasesList().then(setRows).catch(() => setRows([]));
  }, [vp]);

  const pick = (r: PhraseRow) => {
    setSelectedId(r.id);
    setTitle(r.title);
    setText(r.text);
    setSaved(false);
  };

  const startNew = () => {
    setSelectedId(null);
    setTitle('');
    setText('');
    setSaved(false);
  };

  const save = () => {
    if (text.trim().length === 0) return;
    void (async () => {
      // 标题留空就用占位名，避免选择器里出现一行空白
      const finalTitle = title.trim() || t('phrase.untitled');
      // 先取到本地常量再判空：selectedId 是 state，跨 await 之后 TS 的收窄会失效，
      // 直接写 `if (isNew) ... else { id: selectedId }` 在异步闭包里过不了类型检查。
      const id = selectedId;
      try {
        if (id == null) {
          const created = await vp.phrasesSave({ title: finalTitle, text });
          setSelectedId(created.id);
        } else {
          const ok = await vp.phrasesUpdate({ id, title: finalTitle, text });
          if (!ok) return;
        }
        setTitle(finalTitle);
        setRows(await vp.phrasesList());
        setSaved(true);
      } catch {
        /* 保存失败不弹窗：列表仍是真源，用户可重试 */
      }
    })();
  };

  const del = () => {
    if (selectedId == null) return;
    void (async () => {
      const ok = await vp.phrasesDelete(selectedId);
      if (!ok) return;
      setRows(await vp.phrasesList());
      startNew();
    })();
  };

  return (
    <div style={styles.page}>
      <aside style={styles.list}>
        <button data-testid="phrase-new" style={styles.newBtn} onClick={startNew}>
          {t('phrase.new')}
        </button>
        {rows.length === 0 && <div style={styles.empty}>{t('phrase.listEmpty')}</div>}
        {rows.map((r) => (
          <div
            key={r.id}
            data-testid="phrase-list-item"
            style={styles.item(selectedId === r.id)}
            onClick={() => pick(r)}
          >
            <div style={styles.itemTitle}>{r.title}</div>
            <div style={styles.itemSnippet}>{r.text.replace(/\s+/g, ' ').slice(0, 40)}</div>
          </div>
        ))}
      </aside>

      <main style={styles.detail}>
        <label style={styles.label} htmlFor="phrase-edit-title">{t('phrase.title')}</label>
        <input
          id="phrase-edit-title"
          data-testid="phrase-edit-title"
          style={styles.input}
          value={title}
          onChange={(e) => { setTitle(e.target.value); setSaved(false); }}
          placeholder={t('phrase.untitled')}
        />
        <label style={styles.label} htmlFor="phrase-edit-text">{t('phrase.text')}</label>
        <textarea
          id="phrase-edit-text"
          data-testid="phrase-edit-text"
          style={styles.textarea}
          value={text}
          onChange={(e) => { setText(e.target.value); setSaved(false); }}
        />
        <div style={styles.actions}>
          <button
            data-testid="phrase-save"
            style={styles.primary}
            onClick={save}
            disabled={text.trim().length === 0}
          >
            {t('phrase.save')}
          </button>
          {selectedId != null && (
            <button data-testid="phrase-delete" style={styles.danger} onClick={del}>
              {t('phrase.delete')}
            </button>
          )}
          {saved && <span style={styles.hint}>{t('phrase.saved')}</span>}
        </div>
      </main>
    </div>
  );
}

const styles = {
  page: { flex: 1, minHeight: 0, display: 'flex', background: '#ffffff', color: '#1f2937', fontSize: 13 },
  list: { width: 240, flexShrink: 0, overflowY: 'auto', borderRight: '1px solid #e5e7eb', padding: 8, boxSizing: 'border-box' },
  empty: { color: '#9ca3af', padding: 16, textAlign: 'center' },
  newBtn: {
    width: '100%', padding: '6px 10px', marginBottom: 8, boxSizing: 'border-box',
    borderRadius: 6, border: '1px dashed #d1d5db', background: 'transparent',
    color: '#374151', fontSize: 12, cursor: 'pointer',
  },
  item: (active: boolean) => ({
    padding: '8px 10px', marginBottom: 4, borderRadius: 6, cursor: 'pointer',
    boxSizing: 'border-box',
    background: active ? '#eff6ff' : 'transparent',
  }),
  itemTitle: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  itemSnippet: { color: '#9ca3af', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  detail: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', padding: 16, gap: 8, boxSizing: 'border-box' },
  label: { color: '#6b7280', fontSize: 12, flexShrink: 0 },
  input: {
    flexShrink: 0, padding: '6px 8px', borderRadius: 6, border: '1px solid #d1d5db',
    background: '#ffffff', color: '#111827', fontFamily: 'inherit', fontSize: 13, outline: 'none',
  },
  textarea: {
    flex: 1, minHeight: 0, padding: 10, borderRadius: 8, border: '1px solid #e5e7eb',
    background: '#fafafa', color: '#111827', fontFamily: 'inherit', fontSize: 13,
    lineHeight: 1.6, resize: 'none', outline: 'none',
  },
  actions: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  primary: { padding: '5px 14px', borderRadius: 6, border: '1px solid #1d4ed8', background: '#1d4ed8', color: '#ffffff', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  danger: { padding: '5px 14px', borderRadius: 6, border: '1px solid #fecaca', background: '#ffffff', color: '#dc2626', fontSize: 12, cursor: 'pointer' },
  hint: { color: '#6b7280', fontSize: 11 },
} satisfies Record<string, CSSProperties | ((active: boolean) => CSSProperties)>;
