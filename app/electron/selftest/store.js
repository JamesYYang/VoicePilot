import {
  openStore, saveHistory, listHistory, getHistory, updateHistoryPolish,
  listPresets, savePreset, deletePreset, getMeta, setMeta,
} from '../store.js';

export async function runStoreSelftest() {
  console.log('[自测] 本地存储（store）');
  openStore(':memory:');

  // 播种：4 场景 + 4 语气，全 is_builtin=1
  const scenes = listPresets('scene');
  const tones = listPresets('tone');
  const okSeed = scenes.length === 4 && tones.length === 4 &&
    scenes.every((p) => p.is_builtin === 1) && tones.every((p) => p.is_builtin === 1);
  const okDocFirst = scenes[0]?.name === '文档';

  // 历史写入 + 列表
  const { id } = saveHistory({ text: '第一段口述', durationMs: 12000 });
  const rows = listHistory({});
  const okWrite = id === 1 && rows.length === 1 && rows[0].text === '第一段口述' &&
    rows[0].duration_ms === 12000 && rows[0].polished === null;

  // 润色回写
  updateHistoryPolish(id, { polished: '润色版', scene: '邮件', tone: '正式' });
  const got = getHistory(id);
  const okUpdate = got !== null && got.polished === '润色版' && got.scene === '邮件' && got.tone === '正式';

  // 预设增 / 改 / 删
  const { id: pid } = savePreset({ kind: 'scene', name: '周报', description: '每周汇报' });
  const okAdd = listPresets('scene').some((p) => p.id === pid && p.description === '每周汇报');
  savePreset({ id: pid, kind: 'scene', name: '周报', description: '改动后的说明' });
  const okEdit = listPresets('scene').some((p) => p.id === pid && p.description === '改动后的说明');
  const okBuiltinKeep = deletePreset(scenes[0].id) === false; // 内置不可删
  const okDel = deletePreset(pid) === true;

  // meta 读写
  setMeta('first_run_done', 'true');
  const okMeta = getMeta('first_run_done') === 'true';

  const ok = okSeed && okWrite && okUpdate && okAdd && okEdit && okBuiltinKeep && okDel && okMeta && okDocFirst;
  console.log(`[自测] ${ok ? '通过' : '失败'} 播种=${okSeed} 写=${okWrite} 更新=${okUpdate} 增=${okAdd} 改=${okEdit} 内置不删=${okBuiltinKeep} 删=${okDel} meta=${okMeta} 文档首位=${okDocFirst}`);
  return { ok };
}
