import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

/**
 * 润色工作区（Task 4）。
 *
 * 三块：顶部工具条（场景/语气下拉 + 「润色」按钮）、中间可编辑文本框、
 * 底部（「复制」「关闭」）。挂载时 syncStudio() 把悬浮条转出的文本与
 * 场景/语气选项拉进来；点「润色」把 {text, scene, tone} 交给主进程 ——
 * vp.startPolish 本任务还是 stub，Task 5 才接入真正的流式润色。
 *
 * 亮色样式（spec §2）：白底深字，与悬浮条的暗色浮层区分。
 */

interface StudioSync {
  text: string;
  scenes: string[];
  tones: string[];
}

export default function PolishView({ bridge }: { bridge?: Window['voicepilot'] } = {}) {
  const vp = bridge ?? window.voicepilot;

  const [text, setText] = useState('');
  const [scenes, setScenes] = useState<string[]>([]);
  const [tones, setTones] = useState<string[]>([]);
  const [scene, setScene] = useState('');
  const [tone, setTone] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void vp.syncStudio().then((s: StudioSync) => {
      setText(s.text);
      setScenes(s.scenes);
      setTones(s.tones);
      setScene(s.scenes[0] ?? '');
      setTone(s.tones[0] ?? '');
    });
  }, [vp]);

  const run = () => {
    void vp.startPolish({ text, scene, tone });
  };

  const copy = async () => {
    const ok = await vp.copy(text);
    setCopied(ok);
  };

  return (
    <div style={styles.page}>
      <div style={styles.toolbar}>
        <label style={styles.field}>
          <span style={styles.label}>场景</span>
          <select
            data-testid="polish-scene"
            style={styles.select}
            value={scene}
            onChange={(e) => setScene(e.target.value)}
          >
            {scenes.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label style={styles.field}>
          <span style={styles.label}>语气</span>
          <select
            data-testid="polish-tone"
            style={styles.select}
            value={tone}
            onChange={(e) => setTone(e.target.value)}
          >
            {tones.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>

        <button
          data-testid="polish-run"
          style={styles.run}
          onClick={run}
          disabled={text.trim().length === 0}
        >
          润色
        </button>
      </div>

      <textarea
        data-testid="polish-text"
        style={styles.editor}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="在此输入或粘贴要润色的文本"
      />

      <div style={styles.footer}>
        <button
          data-testid="polish-copy"
          style={styles.copy}
          onClick={() => void copy()}
          disabled={text.length === 0}
        >
          复制
        </button>
        <button
          data-testid="polish-close"
          style={styles.ghost}
          onClick={() => window.close()}
        >
          关闭
        </button>
        {copied && <span style={styles.hint}>已复制到剪贴板</span>}
      </div>
    </div>
  );
}

const styles = {
  page: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    padding: 16,
    boxSizing: 'border-box',
    background: '#ffffff',
    color: '#1f2937',
    fontSize: 13,
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flexShrink: 0,
  },
  field: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  label: {
    color: '#6b7280',
    fontSize: 12,
  },
  select: {
    padding: '4px 8px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    background: '#ffffff',
    color: '#111827',
    fontSize: 12,
    outline: 'none',
  },
  run: {
    marginLeft: 'auto',
    padding: '6px 18px',
    borderRadius: 6,
    border: '1px solid #1d4ed8',
    background: '#1d4ed8',
    color: '#ffffff',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  editor: {
    flex: 1,
    minHeight: 0,
    padding: 12,
    borderRadius: 8,
    border: '1px solid #d1d5db',
    background: '#fafafa',
    color: '#111827',
    fontSize: 13,
    lineHeight: 1.6,
    resize: 'none',
    outline: 'none',
    fontFamily: 'inherit',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
  copy: {
    padding: '5px 14px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    background: '#ffffff',
    color: '#111827',
    fontSize: 12,
    cursor: 'pointer',
  },
  ghost: {
    padding: '5px 14px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    background: '#ffffff',
    color: '#6b7280',
    fontSize: 12,
    cursor: 'pointer',
  },
  hint: {
    color: '#6b7280',
    fontSize: 11,
  },
} satisfies Record<string, CSSProperties>;
