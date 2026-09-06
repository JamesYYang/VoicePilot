import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import PresetManager from './PresetManager';

/**
 * 润色工作区（Task 4/5）。
 *
 * 三块：顶部工具条（场景/语气下拉 + 「润色」按钮）、中间并排（左原文可编辑、
 * 右润色结果流式上屏）、底部（「采用」「复制」「关闭」）。挂载时 syncStudio() 把悬浮条
 * 转出的文本与场景/语气选项拉进来；点「润色」把 {text, scene, tone} 交给主进程，
 * 结果经 onPolishDelta 逐块增量追加到输出区，onPolishDone 收尾、onPolishError
 * 显示错误（Task 5 接入真正的流式润色）。
 *
 * 亮色样式（spec §2）：白底深字，与悬浮条的暗色浮层区分。
 */

interface StudioSync {
  text: string;
  scenes: Preset[];
  tones: Preset[];
  defaultScene: string | null;
}

export default function PolishView({ bridge }: { bridge?: Window['voicepilot'] } = {}) {
  const vp = bridge ?? window.voicepilot;

  const [text, setText] = useState('');
  const [scenes, setScenes] = useState<Preset[]>([]);
  const [tones, setTones] = useState<Preset[]>([]);
  const [scene, setScene] = useState<Preset | null>(null);
  const [tone, setTone] = useState<Preset | null>(null);
  const [managerKind, setManagerKind] = useState<'scene' | 'tone' | null>(null);
  const [copied, setCopied] = useState(false);
  const [output, setOutput] = useState('');
  const [polishing, setPolishing] = useState(false);
  const [polishError, setPolishError] = useState<string | null>(null);

  useEffect(() => {
    void vp.syncStudio().then((s: StudioSync) => {
      setText(s.text);
      setScenes(s.scenes);
      setTones(s.tones);
      setScene(s.scenes.find((p) => p.name === s.defaultScene) ?? s.scenes[0] ?? null);
      setTone(s.tones[0] ?? null);
    });
  }, [vp]);

  // 窗口已存在时再点「润色」，主进程只 focus 不重载，改为推送刷新事件，
  // 否则编辑器会一直显示第一次的文本。订阅返回的取消函数即清理函数。
  useEffect(() => vp.onStudioRefresh(({ text: next }) => setText(next)), [vp]);

  // 订阅润色流式事件：delta 逐块追加，done/error 收尾（polishing=false）。
  useEffect(() => {
    const offDelta = vp.onPolishDelta(({ text: d }) => setOutput((prev) => prev + d));
    const offDone = vp.onPolishDone(() => setPolishing(false));
    const offError = vp.onPolishError(({ message }) => {
      setPolishError(message);
      setPolishing(false);
    });
    return () => {
      offDelta();
      offDone();
      offError();
    };
  }, [vp]);

  const run = () => {
    if (!scene || !tone) return;
    setOutput('');
    setPolishError(null);
    setPolishing(true);
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
            value={scene?.name ?? ''}
            onChange={(e) => setScene(scenes.find((p) => p.name === e.target.value) ?? null)}
          >
            {scenes.map((p) => (
              <option key={p.id} value={p.name}>{p.name}</option>
            ))}
          </select>
          <button data-testid="manage-scene" style={styles.manage} onClick={() => setManagerKind('scene')}>管理</button>
        </label>

        <label style={styles.field}>
          <span style={styles.label}>语气</span>
          <select
            data-testid="polish-tone"
            style={styles.select}
            value={tone?.name ?? ''}
            onChange={(e) => setTone(tones.find((p) => p.name === e.target.value) ?? null)}
          >
            {tones.map((p) => (
              <option key={p.id} value={p.name}>{p.name}</option>
            ))}
          </select>
          <button data-testid="manage-tone" style={styles.manage} onClick={() => setManagerKind('tone')}>管理</button>
        </label>

        <button
          data-testid="polish-run"
          style={styles.run}
          onClick={run}
          disabled={text.trim().length === 0 || polishing || !scene || !tone}
        >
          {polishing ? '润色中…' : '润色'}
        </button>
      </div>

      <div style={styles.split}>
        <div style={styles.pane}>
          <div style={styles.paneLabel}>原文</div>
          <textarea
            data-testid="polish-text"
            style={styles.editor}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="在此输入或粘贴要润色的文本"
          />
        </div>

        <div style={styles.pane}>
          <div style={styles.paneLabel}>润色结果</div>
          <div data-testid="polish-output" style={styles.output}>
            {output}
          </div>
        </div>
      </div>

      <div style={styles.footer}>
        <button
          data-testid="polish-adopt"
          style={styles.adopt}
          onClick={() => {
            setText(output);
            setOutput('');
            void vp.adoptPolish({ polished: output, scene: scene?.name ?? '', tone: tone?.name ?? '' });
          }}
          disabled={output.length === 0}
        >
          采用
        </button>
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
          onClick={() => void vp.closeStudio()}
        >
          关闭
        </button>
        {copied && <span style={styles.hint}>已复制到剪贴板</span>}
        {polishError && <span style={styles.error}>润色失败：{polishError}</span>}
      </div>

      {managerKind && (
        <PresetManager
          kind={managerKind}
          bridge={bridge}
          onClose={() => setManagerKind(null)}
          onChanged={() => {
            void vp.syncStudio().then((s: StudioSync) => {
              setScenes(s.scenes);
              setTones(s.tones);
              setScene((prev) => s.scenes.find((p) => p.name === prev?.name) ?? s.scenes[0] ?? null);
              setTone((prev) => s.tones.find((p) => p.name === prev?.name) ?? s.tones[0] ?? null);
            });
          }}
        />
      )}
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
  manage: {
    padding: '4px 8px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    background: '#ffffff',
    color: '#111827',
    fontSize: 12,
    cursor: 'pointer',
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
  split: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    gap: 12,
  },
  pane: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  paneLabel: {
    color: '#6b7280',
    fontSize: 12,
    flexShrink: 0,
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
  output: {
    flex: 1,
    minHeight: 0,
    padding: 12,
    borderRadius: 8,
    border: '1px solid #d1d5db',
    background: '#f9fafb',
    color: '#111827',
    fontSize: 13,
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    overflowY: 'auto',
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
  adopt: {
    padding: '5px 14px',
    borderRadius: 6,
    border: '1px solid #1d4ed8',
    background: '#1d4ed8',
    color: '#ffffff',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
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
  error: {
    color: '#dc2626',
    fontSize: 12,
  },
} satisfies Record<string, CSSProperties>;
