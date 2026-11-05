// 本地邮件库（spec 2026-11-05）：MOMAIL1 加密落盘 + data.db 路径索引 + 保留清理。
// DB 只存相对路径与元数据；正文/附件只存在于加密文件。settings.json 管 rootId/rootPath。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { seal, open, generateMasterKey } = require('./crypto');

const ARCHIVE_MAX_BYTES = 25 * 1024 * 1024;
const KEY_NAME = 'archive:master-key';
const ENC_VERSION = 1;

function createArchive({ dataDir, store, secrets, logger, now = () => new Date() }) {
  const settingsFile = path.join(dataDir, 'settings.json');
  let masterKey = null;

  function readSettings() {
    try {
      return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    } catch {
      return {};
    }
  }
  function writeSettings(next) {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = settingsFile + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, settingsFile);
  }
  function archiveCfg() {
    return readSettings().archive || { enabled: false, rootId: null, rootPath: null };
  }

  async function ensureMasterKey() {
    if (masterKey) return masterKey;
    const b64 = await secrets.get(KEY_NAME);
    if (b64) {
      masterKey = Buffer.from(b64, 'base64');
      if (masterKey.length !== 32) throw new Error('归档主密钥长度非法（请清空本地库后重试）');
      return masterKey;
    }
    masterKey = generateMasterKey();
    await secrets.set(KEY_NAME, masterKey.toString('base64'));
    return masterKey;
  }

  const aadOf = (accountId, folder, uid) => `${accountId}|${folder}|${uid}|${ENC_VERSION}`;

  function safeSegments(name) {
    const segs = String(name || '').split('/');
    if (String(name).includes('\\') || segs.some((s) => s === '' || s === '.' || s === '..')) {
      throw new Error(`归档路径名非法（拒绝路径段）: ${name}`);
    }
    return segs.map(encodeURIComponent);
  }
  function buildRelPath(accountId, folder, uid, msgDateMs, sha256) {
    const d = msgDateMs > 0 ? new Date(msgDateMs) : now();
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    return [...safeSegments(accountId), ...safeSegments(folder), month, `${uid}-${sha256.slice(0, 8)}.eml.enc`].join('/');
  }
  const absOf = (rel) => path.join(archiveCfg().rootPath, rel);

  async function setRoot(absPath) {
    const input = String(absPath || '');
    if (!path.isAbsolute(input)) throw new Error('必须提供绝对路径');
    let rp;
    try {
      rp = fs.realpathSync(input);
    } catch {
      throw new Error('目录不存在或不可访问');
    }
    const st = fs.statSync(rp);
    if (!st.isDirectory()) throw new Error('所选路径不是目录');
    if (rp === path.parse(rp).root) throw new Error('不能使用文件系统根目录');
    const probe = path.join(rp, `.momo-probe-${Date.now()}`);
    try {
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
    } catch {
      throw new Error('目录不可写');
    }
    writeSettings({ ...readSettings(), archive: { enabled: true, rootId: crypto.randomUUID(), rootPath: rp } });
    return { rootPath: rp };
  }

  async function read(accountId, folder, uid) {
    const cfg = archiveCfg();
    if (!cfg.enabled || !cfg.rootPath) return null;
    const row = store.getArchiveRow(accountId, folder, uid);
    if (!row || row.state !== 'ok' || row.rootId !== cfg.rootId) return null;
    const abs = absOf(row.relPath);
    let sealed;
    try {
      sealed = fs.readFileSync(abs);
    } catch {
      store.setArchiveState(accountId, folder, uid, 'missing');
      return null;
    }
    try {
      return { raw: open(sealed, await ensureMasterKey(), aadOf(accountId, folder, uid)) };
    } catch {
      try { fs.unlinkSync(abs); } catch { /* 删失败由 verifyStartup 兜底 */ }
      store.setArchiveState(accountId, folder, uid, 'corrupt');
      logger.warn('归档文件解密失败，已删除并标记 corrupt', { accountId, folder, uid });
      return null;
    }
  }

  async function write(accountId, folder, uid, raw, msgDateMs) {
    const cfg = archiveCfg();
    if (!cfg.enabled || !cfg.rootPath) return { stored: false, reason: 'disabled' };
    safeSegments(accountId);
    safeSegments(folder);
    const sha = crypto.createHash('sha256').update(raw).digest('hex');
    const msgDate = Number(msgDateMs) || 0;
    if (raw.length > ARCHIVE_MAX_BYTES) {
      store.upsertArchiveRow({ accountId, folder, uid, rootId: cfg.rootId, relPath: '', sizeBytes: 0,
        sha256: sha, encVersion: ENC_VERSION, msgDate, state: 'too_large', cachedAt: Date.now() });
      return { stored: false, reason: 'too_large' };
    }
    let rel;
    try {
      rel = buildRelPath(accountId, folder, uid, msgDate, sha);
    } catch (err) {
      return { stored: false, reason: 'error', error: err instanceof Error ? err.message : String(err) };
    }
    const abs = absOf(rel);
    try {
      const key = await ensureMasterKey();
      const sealed = seal(raw, key, aadOf(accountId, folder, uid));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = abs + '.tmp-' + process.pid + '-' + Date.now();
      fs.writeFileSync(tmp, sealed);
      fs.renameSync(tmp, abs);
      store.upsertArchiveRow({ accountId, folder, uid, rootId: cfg.rootId, relPath: rel, sizeBytes: sealed.length,
        sha256: sha, encVersion: ENC_VERSION, msgDate, state: 'ok', cachedAt: Date.now() });
      return { stored: true };
    } catch (err) {
      return { stored: false, reason: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function prune(accountId, cutoffMs) {
    if (cutoffMs == null) return { removed: 0 };
    const cfg = archiveCfg();
    let removed = 0;
    for (const row of store.listArchiveRows(accountId, { state: 'ok' })) {
      if (row.rootId !== cfg.rootId || row.msgDate <= 0 || row.msgDate >= cutoffMs) continue;
      try { fs.unlinkSync(absOf(row.relPath)); } catch { /* 文件已不在 */ }
      store.deleteArchiveRows(accountId, { folder: row.folder, uid: row.uid });
      removed += 1;
    }
    return { removed };
  }

  function rmAccountDir(accountId) {
    try {
      fs.rmSync(path.join(archiveCfg().rootPath, ...safeSegments(accountId)), { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
  async function removeAccount(accountId) {
    const removed = store.deleteArchiveRows(accountId);
    rmAccountDir(accountId);
    return { removed };
  }
  async function clearCurrent() {
    const cfg = archiveCfg();
    if (!cfg.enabled || !cfg.rootPath) return { removed: 0 };
    let total = 0;
    for (const accountId of store.archiveAccountsOfRoot(cfg.rootId)) {
      total += store.deleteArchiveRows(accountId, { rootId: cfg.rootId });
      rmAccountDir(accountId);
    }
    return { removed: total };
  }

  async function stats() {
    const cfg = archiveCfg();
    const s = cfg.rootId ? store.archiveStats(cfg.rootId)
      : { files: 0, bytes: 0, missing: 0, corrupt: 0, tooLarge: 0 };
    return { enabled: !!cfg.enabled, rootPath: cfg.rootPath || null, rootId: cfg.rootId || null, ...s };
  }

  async function verifyStartup(accountIds) {
    const cfg = archiveCfg();
    if (!cfg.enabled || !cfg.rootPath) return { fixedMissing: 0, removedOrphans: 0 };
    let fixedMissing = 0;
    let removedOrphans = 0;
    for (const accountId of accountIds) {
      const referenced = new Set();
      for (const row of store.listArchiveRows(accountId)) {
        if (row.rootId !== cfg.rootId) continue;
        if (row.state === 'ok') {
          if (fs.existsSync(absOf(row.relPath))) referenced.add(row.relPath);
          else {
            store.setArchiveState(accountId, row.folder, row.uid, 'missing');
            fixedMissing += 1;
          }
        }
      }
      const accDir = path.join(cfg.rootPath, ...safeSegments(accountId));
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) walk(abs);
          else if (!referenced.has(path.relative(cfg.rootPath, abs))) {
            try { fs.unlinkSync(abs); removedOrphans += 1; } catch { /* best-effort */ }
          }
        }
      };
      try { walk(accDir); } catch { /* 账号目录不存在 */ }
    }
    return { fixedMissing, removedOrphans };
  }

  return { read, write, prune, removeAccount, clearCurrent, stats, setRoot, verifyStartup };
}

module.exports = { createArchive, ARCHIVE_MAX_BYTES };
