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

const BUILTIN_SCENES = ['文档', '邮件', '即时通讯', '社媒'];
const BUILTIN_TONES = ['正式', '口语', '简洁', '热情'];

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
  description TEXT NOT NULL DEFAULT '',
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
    'INSERT INTO presets (kind, name, description, is_builtin, sort_order) VALUES (?,?,?,1,?)'
  );
  BUILTIN_SCENES.forEach((name, i) => ins.run('scene', name, '', i));
  BUILTIN_TONES.forEach((name, i) => ins.run('tone', name, '', i));
}

export function openStore(dbPath) {
  if (db) return db;
  const path = dbPath ?? join(app.getPath('userData'), 'voicepilot.db');
  db = new DatabaseSync(path);
  db.exec(SCHEMA);
  seedPresets();
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

export function listPresets(kind) {
  openStore();
  return db
    .prepare('SELECT id, name, description, is_builtin FROM presets WHERE kind = ? ORDER BY sort_order, id')
    .all(kind);
}

export function savePreset({ id, kind, name, description = '' }) {
  openStore();
  if (id != null) {
    db.prepare('UPDATE presets SET name = ?, description = ? WHERE id = ?')
      .run(name, description, id);
    return { id };
  }
  const { m } = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM presets WHERE kind = ?').get(kind);
  const r = db
    .prepare('INSERT INTO presets (kind, name, description, is_builtin, sort_order) VALUES (?,?,?,0,?)')
    .run(kind, name, description, m + 1);
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
