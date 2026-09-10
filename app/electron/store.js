import { app } from 'electron';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

/**
 * 本地持久化层。主进程是唯一读写方，渲染进程永远碰不到这里。
 *
 * 用 Node 内建的 node:sqlite（DatabaseSync 同步 API）而不是 better-sqlite3：
 * Electron 44 内置 Node 24.20.0，node:sqlite 与 FTS5 trigram 均可用（已实测），
 * 省掉原生模块与 electron-rebuild 一整套。三张表：history / presets / meta。
 */

const BUILTIN_SCENES = [
  ['文档', '文檔', 'Document'],
  ['邮件', '郵件', 'Email'],
  ['即时通讯', '即時通訊', 'Instant Messaging'],
  ['社媒', '社媒', 'Social Media'],
];
const BUILTIN_TONES = [
  ['正式', '正式', 'Formal'],
  ['口语', '口語', 'Casual'],
  ['简洁', '簡潔', 'Concise'],
  ['热情', '熱情', 'Warm'],
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  text        TEXT NOT NULL,
  polished    TEXT,
  scene       TEXT,
  tone        TEXT,
  duration_ms INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS presets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK(kind IN ('scene','tone')),
  name        TEXT NOT NULL,
  name_zh_cn  TEXT,
  name_zh_tw  TEXT,
  name_en     TEXT,
  description TEXT NOT NULL DEFAULT '',
  lang        TEXT,
  is_builtin  INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(kind, name)
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

let db = null;

function seedPresets() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM presets').get();
  if (n > 0) return;
  const ins = db.prepare(
    'INSERT INTO presets (kind, name, name_zh_cn, name_zh_tw, name_en, description, is_builtin, sort_order) VALUES (?,?,?,?,?,?,1,?)'
  );
  BUILTIN_SCENES.forEach(([zh, tw, en], i) => ins.run('scene', zh, zh, tw, en, '', i));
  BUILTIN_TONES.forEach(([zh, tw, en], i) => ins.run('tone', zh, zh, tw, en, '', i));
}

/**
 * 旧库迁移：为已存在的 presets 表补三语列与 lang 列。
 * 用 PRAGMA table_info 探测，缺哪列补哪列，不重写表、不动已有数据。
 */
function migratePresets() {
  const cols = db.prepare('PRAGMA table_info(presets)').all().map((c) => c.name);
  const add = (name, ddl) => {
    if (!cols.includes(name)) db.exec(ddl);
  };
  add('name_zh_cn', 'ALTER TABLE presets ADD COLUMN name_zh_cn TEXT');
  add('name_zh_tw', 'ALTER TABLE presets ADD COLUMN name_zh_tw TEXT');
  add('name_en', 'ALTER TABLE presets ADD COLUMN name_en TEXT');
  add('lang', 'ALTER TABLE presets ADD COLUMN lang TEXT');
}

/**
 * 旧元数据迁移：默认场景从存 name（default_scene）改成存 id（default_scene_id）。
 * 若 default_scene_id 已存在则跳过；否则按旧 default_scene 的 name 反查场景 id，
 * 命中写 default_scene_id，未命中（或旧值不存在）则清掉 default_scene 键。
 * 幂等，可安全在每次 openStore 时调用。
 */
export function migrateDefaultScene() {
  openStore();
  if (getMeta('default_scene_id') != null) return;
  const name = getMeta('default_scene');
  if (!name) return;
  const row = db.prepare('SELECT id FROM presets WHERE kind = ? AND name = ?').get('scene', name);
  db.prepare('DELETE FROM meta WHERE key = ?').run('default_scene');
  if (row) setMeta('default_scene_id', row.id);
}

export function openStore(dbPath) {
  if (db) return db;
  const path = dbPath ?? join(app.getPath('userData'), 'voicepilot.db');
  db = new DatabaseSync(path);
  db.exec(SCHEMA);
  migratePresets();
  seedPresets();
  migrateDefaultScene();
  return db;
}

// ---------------------------------------------------------------- 历史

export function saveHistory({ text, durationMs }) {
  openStore();
  const r = db
    .prepare('INSERT INTO history (text, polished, scene, tone, duration_ms, created_at) VALUES (?, NULL, NULL, NULL, ?, ?)')
    .run(text, durationMs ?? null, Date.now());
  return { id: Number(r.lastInsertRowid) };
}

export function listHistory({ limit = 200, offset = 0 } = {}) {
  openStore();
  return db
    .prepare('SELECT id, text, polished, scene, tone, duration_ms, created_at FROM history ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(limit, offset);
}

export function getHistory(id) {
  openStore();
  return db
    .prepare('SELECT id, text, polished, scene, tone, duration_ms, created_at FROM history WHERE id = ?')
    .get(id) ?? null;
}

export function updateHistoryPolish(id, { polished, scene, tone }) {
  openStore();
  db.prepare('UPDATE history SET polished = ?, scene = ?, tone = ? WHERE id = ?')
    .run(polished ?? null, scene ?? null, tone ?? null, id);
}

// ---------------------------------------------------------------- 预设

export function listPresets(kind, locale = 'zh-CN') {
  openStore();
  const rows = db
    .prepare('SELECT id, name, name_zh_cn, name_zh_tw, name_en, description, lang, is_builtin FROM presets WHERE kind = ? ORDER BY sort_order, id')
    .all(kind);
  return rows.map((r) => {
    const name = r.is_builtin
      ? (locale === 'zh-TW' ? r.name_zh_tw : locale === 'en-US' ? r.name_en : r.name_zh_cn) ?? r.name
      : r.name;
    return { id: r.id, name, description: r.description, lang: r.lang, is_builtin: r.is_builtin };
  });
}

export function savePreset({ id, kind, name, description = '', lang = null }) {
  openStore();
  if (id != null) {
    // lang 仅在显式传入时更新，避免编辑预设（不传 lang）把已存的 lang 清成 NULL。
    if (lang != null) {
      db.prepare('UPDATE presets SET name = ?, description = ?, lang = ? WHERE id = ?')
        .run(name, description, lang, id);
    } else {
      db.prepare('UPDATE presets SET name = ?, description = ? WHERE id = ?')
        .run(name, description, id);
    }
    return { id };
  }
  const { m } = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM presets WHERE kind = ?').get(kind);
  const r = db
    .prepare('INSERT INTO presets (kind, name, description, lang, is_builtin, sort_order) VALUES (?,?,?,?,0,?)')
    .run(kind, name, description, lang, m + 1);
  return { id: Number(r.lastInsertRowid) };
}

export function deletePreset(id) {
  openStore();
  const row = db.prepare('SELECT is_builtin FROM presets WHERE id = ?').get(id);
  if (!row || row.is_builtin) return false; // 内置预设不可删
  db.prepare('DELETE FROM presets WHERE id = ?').run(id);
  return true;
}

// ---------------------------------------------------------------- 元数据

export function getMeta(key) {
  openStore();
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return r ? r.value : null;
}

export function setMeta(key, value) {
  openStore();
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
