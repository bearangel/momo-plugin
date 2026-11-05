// 数据层（node:sqlite，Electron 44 / Node 24 内置，无原生依赖）。
// 纪律：service 是唯一写者——agent 工具子进程严禁直开本库，一律走 callService。
// 研发期一次性重置：init 清理旧 drafts.json 与 cache/（不做数据迁移）。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 3;
const MAX_ITEMS = 500;

const SCHEMA_V1 = `
CREATE TABLE drafts (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, uid INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, to_json TEXT NOT NULL, cc_json TEXT NOT NULL, subject TEXT NOT NULL,
  from_addr TEXT NOT NULL, summary TEXT NOT NULL,
  attachment_names_json TEXT NOT NULL, input_payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL, sent_at TEXT, last_error TEXT,
  expire_reason TEXT, archive_warning TEXT, delete_warning TEXT
);
CREATE INDEX idx_drafts_status_created ON drafts(status, created_at);

CREATE TABLE envelope_cache (
  account_id TEXT NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL,
  date_ms INTEGER NOT NULL DEFAULT 0,
  envelope_json TEXT NOT NULL,
  PRIMARY KEY (account_id, folder, uid)
);
CREATE TABLE envelope_cache_meta (
  account_id TEXT NOT NULL, folder TEXT NOT NULL, saved_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, folder)
);
`;

const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS folder_cache (
  account_id TEXT PRIMARY KEY NOT NULL,
  payload_json TEXT NOT NULL,
  saved_at INTEGER NOT NULL
);
`;

const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS local_archive (
  account_id TEXT NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL,
  root_id TEXT NOT NULL, rel_path TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL, enc_version INTEGER NOT NULL, msg_date INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL, cached_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, folder, uid)
);
CREATE INDEX IF NOT EXISTS idx_local_archive_root ON local_archive(root_id);
`;

function dateMsOf(envelope) {
  const t = Date.parse(envelope && envelope.date);
  return Number.isFinite(t) ? t : 0;
}

function rowToDraft(row) {
  return {
    id: row.id,
    accountId: row.account_id,
    uid: Number(row.uid),
    status: row.status,
    to: JSON.parse(row.to_json),
    cc: JSON.parse(row.cc_json),
    subject: row.subject,
    fromAddr: row.from_addr,
    summary: row.summary,
    attachmentNames: JSON.parse(row.attachment_names_json),
    inputPayload: JSON.parse(row.input_payload_json),
    createdAt: row.created_at,
    sentAt: row.sent_at ?? null,
    lastError: row.last_error ?? null,
    expireReason: row.expire_reason ?? null,
    archiveWarning: row.archive_warning ?? null,
    deleteWarning: row.delete_warning ?? null,
  };
}

function rowToArchive(r) {
  return {
    accountId: r.account_id, folder: r.folder, uid: Number(r.uid), rootId: r.root_id,
    relPath: r.rel_path, sizeBytes: Number(r.size_bytes), sha256: r.sha256,
    encVersion: Number(r.enc_version), msgDate: Number(r.msg_date), state: r.state, cachedAt: Number(r.cached_at),
  };
}

function createStore({ dataDir }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'data.db');
  let db;
  try {
    db = new DatabaseSync(dbPath);
  } catch (err) {
    throw new Error(`打开数据文件失败（${dbPath}）：${err.message}`);
  }
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA busy_timeout=5000');
    db.exec('PRAGMA synchronous=NORMAL');
    db.exec('PRAGMA foreign_keys=ON');
    let version = Number(db.prepare('PRAGMA user_version').get().user_version ?? 0);
    if (version > SCHEMA_VERSION) throw new Error('数据文件由更新版本插件创建，请升级插件');
    if (version < 1) {
      db.exec('BEGIN');
      try {
        db.exec(SCHEMA_V1);
        db.exec('PRAGMA user_version=1');
        db.exec('COMMIT');
        version = 1;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
    if (version < 2) {
      db.exec('BEGIN');
      try {
        db.exec(SCHEMA_V2);
        db.exec('PRAGMA user_version=2');
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
    if (version < 3) {
      db.exec('BEGIN');
      try {
        db.exec(SCHEMA_V3);
        db.exec('PRAGMA user_version=3');
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
  } catch (err) {
    try { db.close(); } catch { /* 关闭失败无可挽回 */ }
    if (String(err.message).includes('更新版本插件')) throw err;
    throw new Error(`初始化数据文件失败（${dbPath}）：${err.message}`);
  }
  // 研发期一次性清理：旧 JSON 实现产物直接丢弃（失败无害，不阻断启动）
  try { fs.rmSync(path.join(dataDir, 'drafts.json'), { force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(path.join(dataDir, 'cache'), { recursive: true, force: true }); } catch { /* best-effort */ }

  const insertDraftStmt = db.prepare(`
    INSERT INTO drafts (id, account_id, uid, status, to_json, cc_json, subject, from_addr, summary,
      attachment_names_json, input_payload_json, created_at, sent_at, last_error,
      expire_reason, archive_warning, delete_warning)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const updateDraftStmt = db.prepare(`
    UPDATE drafts SET account_id = ?, uid = ?, status = ?, to_json = ?, cc_json = ?, subject = ?,
      from_addr = ?, summary = ?, attachment_names_json = ?, input_payload_json = ?,
      created_at = ?, sent_at = ?, last_error = ?, expire_reason = ?, archive_warning = ?, delete_warning = ?
    WHERE id = ?`);
  const deleteDraftsStmt = db.prepare('DELETE FROM drafts WHERE id = ?');

  function bindDraft(rec) {
    return [
      rec.id, rec.accountId, Number(rec.uid) || 0, rec.status,
      JSON.stringify(rec.to ?? []), JSON.stringify(rec.cc ?? []), String(rec.subject ?? ''),
      String(rec.fromAddr ?? ''), String(rec.summary ?? ''),
      JSON.stringify(rec.attachmentNames ?? []), JSON.stringify(rec.inputPayload ?? {}),
      rec.createdAt, rec.sentAt ?? null, rec.lastError ?? null,
      rec.expireReason ?? null, rec.archiveWarning ?? null, rec.deleteWarning ?? null,
    ];
  }

  return {
    MAX_ITEMS,
    listDrafts() {
      return db.prepare('SELECT * FROM drafts ORDER BY rowid ASC').all().map(rowToDraft);
    },
    getDraft(id) {
      const row = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id);
      return row ? rowToDraft(row) : null;
    },
    insertDraft(rec) {
      insertDraftStmt.run(...bindDraft(rec));
      return rec;
    },
    updateDraft(id, rec) {
      const params = bindDraft({ ...rec, id });
      const info = updateDraftStmt.run(...params.slice(1), id);
      if (Number(info.changes) === 0) throw new Error(`草稿不存在: ${id}`);
      return rec;
    },
    deleteDrafts(ids) {
      for (const id of ids || []) deleteDraftsStmt.run(id);
    },
    readEnvelopes(accountId, folder) {
      const meta = db.prepare('SELECT saved_at FROM envelope_cache_meta WHERE account_id = ? AND folder = ?')
        .get(accountId, folder);
      if (!meta) return null;
      const rows = db.prepare(
        'SELECT envelope_json FROM envelope_cache WHERE account_id = ? AND folder = ? ORDER BY uid DESC LIMIT ?',
      ).all(accountId, folder, MAX_ITEMS);
      return { items: rows.map((r) => JSON.parse(r.envelope_json)), savedAt: Number(meta.saved_at) };
    },
    writeEnvelopes(accountId, folder, envelopes, { cutoffMs } = {}) {
      const sorted = (Array.isArray(envelopes) ? envelopes : [])
        .filter((e) => e && Number.isInteger(e.uid))
        .sort((a, b) => b.uid - a.uid)
        .slice(0, MAX_ITEMS);
      const kept = cutoffMs == null ? sorted : sorted.filter((e) => {
        const t = dateMsOf(e);
        return t === 0 || t >= cutoffMs;
      });
      const delItems = db.prepare('DELETE FROM envelope_cache WHERE account_id = ? AND folder = ?');
      const insert = db.prepare(
        'INSERT INTO envelope_cache (account_id, folder, uid, date_ms, envelope_json) VALUES (?, ?, ?, ?, ?)',
      );
      const upsertMeta = db.prepare(`
        INSERT INTO envelope_cache_meta (account_id, folder, saved_at) VALUES (?, ?, ?)
        ON CONFLICT(account_id, folder) DO UPDATE SET saved_at = excluded.saved_at`);
      db.exec('BEGIN');
      try {
        delItems.run(accountId, folder);
        for (const e of kept) insert.run(accountId, folder, e.uid, dateMsOf(e), JSON.stringify(e));
        upsertMeta.run(accountId, folder, Date.now());
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    readFoldersCache(accountId) {
      const row = db.prepare('SELECT payload_json, saved_at FROM folder_cache WHERE account_id = ?').get(accountId);
      if (!row) return null;
      try {
        return { value: JSON.parse(row.payload_json), savedAt: Number(row.saved_at) };
      } catch {
        return null;
      }
    },
    writeFoldersCache(accountId, value) {
      db.prepare(`
        INSERT INTO folder_cache (account_id, payload_json, saved_at) VALUES (?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET payload_json = excluded.payload_json, saved_at = excluded.saved_at`)
        .run(accountId, JSON.stringify(value), Date.now());
    },
    invalidateEnvelopes(accountId, folder) {
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM envelope_cache WHERE account_id = ? AND folder = ?').run(accountId, folder);
        db.prepare('DELETE FROM envelope_cache_meta WHERE account_id = ? AND folder = ?').run(accountId, folder);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    getArchiveRow(accountId, folder, uid) {
      const r = db.prepare('SELECT * FROM local_archive WHERE account_id = ? AND folder = ? AND uid = ?')
        .get(accountId, folder, uid);
      return r ? rowToArchive(r) : null;
    },
    upsertArchiveRow(row) {
      db.prepare(`INSERT INTO local_archive (account_id, folder, uid, root_id, rel_path, size_bytes, sha256, enc_version, msg_date, state, cached_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, folder, uid) DO UPDATE SET root_id=excluded.root_id, rel_path=excluded.rel_path,
          size_bytes=excluded.size_bytes, sha256=excluded.sha256, enc_version=excluded.enc_version,
          msg_date=excluded.msg_date, state=excluded.state, cached_at=excluded.cached_at`)
        .run(row.accountId, row.folder, Number(row.uid) || 0, row.rootId, row.relPath,
          Number(row.sizeBytes) || 0, row.sha256, Number(row.encVersion) || 1,
          Number(row.msgDate) || 0, row.state, Number(row.cachedAt) || Date.now());
    },
    setArchiveState(accountId, folder, uid, state) {
      db.prepare('UPDATE local_archive SET state = ? WHERE account_id = ? AND folder = ? AND uid = ?')
        .run(state, accountId, folder, uid);
    },
    deleteArchiveRows(accountId, opts = {}) {
      let sql = 'DELETE FROM local_archive WHERE account_id = ?';
      const args = [accountId];
      if (opts.folder) { sql += ' AND folder = ?'; args.push(opts.folder); }
      if (opts.uid !== undefined) { sql += ' AND uid = ?'; args.push(opts.uid); }
      if (opts.rootId) { sql += ' AND root_id = ?'; args.push(opts.rootId); }
      return Number(db.prepare(sql).run(...args).changes);
    },
    listArchiveRows(accountId, opts = {}) {
      let sql = 'SELECT * FROM local_archive WHERE account_id = ?';
      const args = [accountId];
      if (opts.state) { sql += ' AND state = ?'; args.push(opts.state); }
      return db.prepare(sql).all(...args).map(rowToArchive);
    },
    archiveAccountsOfRoot(rootId) {
      return db.prepare('SELECT DISTINCT account_id AS id FROM local_archive WHERE root_id = ?').all(rootId)
        .map((r) => String(r.id));
    },
    archiveStats(rootId) {
      const r = db.prepare(`SELECT
        SUM(CASE WHEN state='ok' THEN 1 ELSE 0 END) AS files,
        SUM(CASE WHEN state='ok' THEN size_bytes ELSE 0 END) AS bytes,
        SUM(CASE WHEN state='missing' THEN 1 ELSE 0 END) AS missing,
        SUM(CASE WHEN state='corrupt' THEN 1 ELSE 0 END) AS corrupt,
        SUM(CASE WHEN state='too_large' THEN 1 ELSE 0 END) AS tooLarge
        FROM local_archive WHERE root_id = ?`).get(rootId) ?? {};
      return {
        files: Number(r.files) || 0, bytes: Number(r.bytes) || 0, missing: Number(r.missing) || 0,
        corrupt: Number(r.corrupt) || 0, tooLarge: Number(r.tooLarge) || 0,
      };
    },
    close() { db.close(); },
  };
}

module.exports = { createStore, SCHEMA_VERSION, MAX_ITEMS };
