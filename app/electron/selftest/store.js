import { DatabaseSync } from 'node:sqlite';
import {
  openStore, openStoreWithDb, saveHistory, listHistory, getHistory, updateHistoryPolish,
  deleteHistory, listPresets, savePreset, deletePreset, getMeta, setMeta, migrateDefaultScene,
} from '../store.js';

export async function runStoreSelftest() {
  console.log('[自测] 本地存储（store）');
  openStore(':memory:');

  // 播种：4 场景 + 4 语气，全 is_builtin=1；默认 zh-CN 名 + 三语解析
  const scenes = listPresets('scene');
  const tones = listPresets('tone');
  const okSeed = scenes.length === 4 && tones.length === 4 &&
    scenes.every((p) => p.is_builtin === 1) && tones.every((p) => p.is_builtin === 1);
  const okTrilingual = scenes[0]?.name === '文档' &&
    listPresets('scene', 'zh-TW')[0]?.name === '文檔' &&
    listPresets('scene', 'en-US')[0]?.name === 'Document';

  // 历史写入 + 列表
  const { id } = saveHistory({ text: '第一段口述', durationMs: 12000 });
  const rows = listHistory({});
  const okWrite = id === 1 && rows.length === 1 && rows[0].text === '第一段口述' &&
    rows[0].duration_ms === 12000 && rows[0].polished === null;

  // 润色回写
  updateHistoryPolish(id, { polished: '润色版', scene: '邮件', tone: '正式' });
  const got = getHistory(id);
  const okUpdate = got !== null && got.polished === '润色版' && got.scene === '邮件' && got.tone === '正式';

  // 历史删除
  const okDelHistory = deleteHistory(id) === true;
  const okDelGone = getHistory(id) === null;
  const okDelMissing = deleteHistory(999999) === false;

  // 预设增 / 改 / 删（lang 随自定义预设写入并回读）
  const { id: pid } = savePreset({ kind: 'scene', name: '周报', description: '每周汇报', lang: 'zh-CN' });
  const okAdd = listPresets('scene').some((p) => p.id === pid && p.description === '每周汇报' && p.lang === 'zh-CN');
  savePreset({ id: pid, kind: 'scene', name: '周报', description: '改动后的说明' });
  const okEdit = listPresets('scene').some((p) => p.id === pid && p.description === '改动后的说明' && p.lang === 'zh-CN');
  const okBuiltinKeep = deletePreset(scenes[0].id) === false; // 内置不可删
  const okDel = deletePreset(pid) === true;

  // meta 读写
  setMeta('first_run_done', 'true');
  const okMeta = getMeta('first_run_done') === 'true';

  // 旧 default_scene(name) → default_scene_id(id) 迁移
  setMeta('default_scene', '不存在的场景');
  migrateDefaultScene();
  const okMigrateMiss = getMeta('default_scene_id') == null && getMeta('default_scene') == null;
  setMeta('default_scene', '邮件');
  migrateDefaultScene();
  const okMigrateHit = getMeta('default_scene_id') === '2' && getMeta('default_scene') == null;
  migrateDefaultScene(); // 幂等：已有 default_scene_id，不再动
  const okMigrateIdem = getMeta('default_scene_id') === '2';

  // ---- 旧 schema → migratePresets 补列 + 三语回填（真实迁移路径）----
  // 手工建一个只有旧列（无 name_zh_cn / name_zh_tw / name_en / lang）的 presets 表，
  // 插两条内置行，再经 openStoreWithDb 走完整迁移管线，断言三语列被回填正确。
  const oldDb = new DatabaseSync(':memory:');
  oldDb.exec(`
    CREATE TABLE presets (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT NOT NULL,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      is_builtin  INTEGER NOT NULL DEFAULT 0,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      UNIQUE(kind, name)
    );
  `);
  oldDb.prepare('INSERT INTO presets (kind, name, description, is_builtin, sort_order) VALUES (?,?,?,?,?)')
    .run('scene', '文档', '', 1, 0);
  oldDb.prepare('INSERT INTO presets (kind, name, description, is_builtin, sort_order) VALUES (?,?,?,?,?)')
    .run('tone', '正式', '', 1, 0);

  openStoreWithDb(oldDb);

  const migratedScene = oldDb.prepare(
    'SELECT name_zh_cn, name_zh_tw, name_en FROM presets WHERE kind = ? AND name = ?'
  ).get('scene', '文档');
  const migratedTone = oldDb.prepare(
    'SELECT name_zh_cn, name_zh_tw, name_en FROM presets WHERE kind = ? AND name = ?'
  ).get('tone', '正式');
  const okMigrateBackfill =
    migratedScene?.name_zh_cn === '文档' && migratedScene?.name_zh_tw === '文檔' && migratedScene?.name_en === 'Document' &&
    migratedTone?.name_zh_cn === '正式' && migratedTone?.name_zh_tw === '正式' && migratedTone?.name_en === 'Formal';

  // listPresets 三语读回（走真实回退逻辑：内置行取对应 locale 列）
  const okMigrateList =
    listPresets('scene', 'zh-TW')[0]?.name === '文檔' &&
    listPresets('scene', 'en-US')[0]?.name === 'Document' &&
    listPresets('tone', 'zh-TW')[0]?.name === '正式' &&
    listPresets('tone', 'en-US')[0]?.name === 'Formal';

  // 幂等：再跑一遍迁移，三语列保持不变
  openStoreWithDb(oldDb);
  const again = oldDb.prepare(
    'SELECT name_zh_cn, name_zh_tw, name_en FROM presets WHERE kind = ? AND name = ?'
  ).get('scene', '文档');
  const okMigrateBackfillIdem =
    again?.name_zh_cn === '文档' && again?.name_zh_tw === '文檔' && again?.name_en === 'Document';

  const ok = okSeed && okWrite && okUpdate && okDelHistory && okDelGone && okDelMissing && okAdd && okEdit && okBuiltinKeep && okDel && okMeta && okTrilingual &&
    okMigrateMiss && okMigrateHit && okMigrateIdem &&
    okMigrateBackfill && okMigrateList && okMigrateBackfillIdem;
  console.log(`[自测] ${ok ? '通过' : '失败'} 播种=${okSeed} 写=${okWrite} 更新=${okUpdate} 删历史=${okDelHistory && okDelGone && okDelMissing} 增=${okAdd} 改=${okEdit} 内置不删=${okBuiltinKeep} 删=${okDel} meta=${okMeta} 三语=${okTrilingual} 迁移未命中=${okMigrateMiss} 迁移命中=${okMigrateHit} 迁移幂等=${okMigrateIdem} 回填=${okMigrateBackfill} 回填列表=${okMigrateList} 回填幂等=${okMigrateBackfillIdem}`);
  return { ok };
}
