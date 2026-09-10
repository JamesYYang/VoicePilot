import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useT } from '../i18n';

/**
 * 预设管理模态框（场景 / 语气）。
 *
 * 内置条目（is_builtin=1）可改名/编辑说明，删除按钮禁用；用户新建的可删。
 * 新增/编辑共用一个输入框表单；保存/删除后经 onChanged 通知父组件刷新下拉。
 */

interface Props {
  kind: 'scene' | 'tone';
  bridge?: Window['voicepilot'];
  onClose: () => void;
  onChanged: () => void;
}

export default function PresetManager({ kind, bridge, onClose, onChanged }: Props) {
  const vp = bridge ?? window.voicepilot;
  const t = useT();
  const [presets, setPresets] = useState<Preset[]>([]);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () => {
    void vp.listPresets(kind).then(setPresets);
  };

  useEffect(reload, [vp, kind]);

  const startEdit = (p: Preset) => {
    setEditingId(p.id);
    setName(p.name);
    setDesc(p.description);
    setError(null);
  };

  const reset = () => {
    setEditingId(null);
    setName('');
    setDesc('');
    setError(null);
  };

  const save = async () => {
    if (!name.trim()) return;
    if (presets.some((p) => p.name === name.trim() && p.id !== editingId)) {
      setError(t('preset.nameExists'));
      return;
    }
    try {
      await vp.savePreset({ id: editingId ?? undefined, kind, name: name.trim(), description: desc.trim() });
      setError(null);
      reset();
      reload();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const del = async (id: number) => {
    try {
      await vp.deletePreset(id);
      setError(null);
      reload();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.head}>
          <span>{kind === 'scene' ? t('preset.manageScene') : t('preset.manageTone')}</span>
          <button style={styles.close} onClick={onClose}>×</button>
        </div>

        <div style={styles.list}>
          {presets.map((p) => (
            <div key={p.id} style={styles.row}>
              <div style={styles.rowMain}>
                <div style={styles.rowName}>{p.name}</div>
                {p.description && <div style={styles.rowDesc}>{p.description}</div>}
              </div>
              <button style={styles.link} onClick={() => startEdit(p)}>{t('preset.edit')}</button>
              <button style={styles.link} disabled={p.is_builtin === 1} onClick={() => void del(p.id)}>
                {p.is_builtin === 1 ? t('preset.builtin') : t('preset.delete')}
              </button>
            </div>
          ))}
        </div>

        <div style={styles.form}>
          <input
            style={styles.input}
            placeholder={t('preset.name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            style={styles.input}
            placeholder={t('preset.descPlaceholder')}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
          <button style={styles.primary} onClick={() => void save()} disabled={!name.trim()}>
            {editingId == null ? t('preset.add') : t('preset.save')}
          </button>
          {editingId != null && <button style={styles.link} onClick={reset}>{t('preset.cancelEdit')}</button>}
        </div>
        {error && <div style={styles.error}>{error}</div>}
      </div>
    </div>
  );
}

const styles = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10 },
  modal: { width: 420, maxHeight: '80vh', display: 'flex', flexDirection: 'column', gap: 10, background: '#ffffff', borderRadius: 10, padding: 16, boxShadow: '0 8px 30px rgba(0,0,0,0.2)', color: '#1f2937', fontSize: 13 },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontWeight: 600 },
  close: { border: 'none', background: 'transparent', fontSize: 18, cursor: 'pointer', color: '#6b7280' },
  list: { display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto' },
  row: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, background: '#f9fafb' },
  rowMain: { flex: 1, minWidth: 0 },
  rowName: { fontWeight: 500 },
  rowDesc: { color: '#6b7280', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  link: { border: 'none', background: 'transparent', color: '#1d4ed8', fontSize: 12, cursor: 'pointer', padding: 2 },
  form: { display: 'flex', gap: 6, alignItems: 'center' },
  input: { flex: 1, minWidth: 0, padding: '5px 8px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 12, outline: 'none' },
  primary: { padding: '5px 12px', borderRadius: 6, border: '1px solid #1d4ed8', background: '#1d4ed8', color: '#ffffff', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  error: { color: '#dc2626', fontSize: 12 },
} satisfies Record<string, CSSProperties>;
