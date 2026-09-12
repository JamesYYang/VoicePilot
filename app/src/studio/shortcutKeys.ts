/**
 * 把键盘事件映射成 Electron accelerator 的键名。
 * 无法表达时返回 null —— 调用方必须据此拒绝，而不是把原始 e.key 拼进去。
 * 参考 Electron accelerator 支持的键名（Space / Up / Down / Left / Right / Return /
 * Tab / Backspace / Delete / Insert / Home / End / PageUp / PageDown / Esc / F1-F24 / Plus / Minus）。
 */
const SPECIAL: Record<string, string> = {
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Return',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Escape: 'Esc',
  '+': 'Plus',
  '-': 'Minus',
};

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** 单个键名；不可表达返回 null。 */
export function acceleratorKeyName(e: Pick<KeyEventLike, 'key'>): string | null {
  const k = e.key;
  if (SPECIAL[k]) return SPECIAL[k];
  if (/^[a-zA-Z0-9]$/.test(k)) return k.toUpperCase();
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(k)) return k;
  return null;
}

/** 组装 accelerator；无可表达的键名、或没有任何修饰键时返回 null。 */
export function acceleratorFromEvent(e: KeyEventLike): string | null {
  const name = acceleratorKeyName(e);
  if (!name) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  if (mods.length === 0) return null;
  return [...mods, name].join('+');
}
