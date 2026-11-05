// mailbox：IMAP 域适配层。缓存优先（信封 TTL 5min）；正文/附件按需；全部操作 30s 超时。
// 连接复用：每账号一条，10min 空闲回收。
'use strict';

const { decodeModifiedUtf7 } = require('./utf7');

const CACHE_TTL_MS = 5 * 60 * 1000;
const READ_SOURCE_MAX = 2 * 1024 * 1024;   // read_mail 全源上限
const TEXT_TRUNCATE = 200 * 1024;           // 正文截断
const ATTACH_MAX = 10 * 1024 * 1024;        // 附件 RPC 上限
const IDLE_MS = 10 * 60 * 1000;             // 连接空闲回收
const READ_CACHE_MAX = 50;                  // 正文内存 LRU 容量
const FOLDERS_TTL_MS = 60 * 1000;           // 文件夹树缓存（切账号体感）

// 兜底名匹配统一走 norm（去空白+小写），故常量表预先归一——'Sent Items' 归一后是 'sentitems'。
const norm = (s) => String(s || '').toLowerCase().replace(/\s/g, '');
const DRAFT_NAMES = ['drafts', '草稿箱', '草稿', 'draft'].map(norm);
const SENT_NAMES = ['sent', '已发送', '已发送邮件', '发件箱', 'sent messages', 'sent items'].map(norm);

function findFolder(raw, specialUse, names) {
  const special = raw.find((f) => f.specialUse === specialUse);
  if (special) return special.path;
  // path/name 的原样 + modified-UTF-7 解码 + 末段（新浪等以编码父路径出现）都要比对
  const variants = (f) => [f.path, f.name]
    .filter((v) => typeof v === 'string')
    .flatMap((v) => {
      const d = decodeModifiedUtf7(v);
      return [norm(v), norm(d), norm(v.split('/').pop()), norm(d.split('/').pop())];
    });
  return raw.find((f) => variants(f).some((v) => names.includes(v)))?.path ?? null;
}

function createMailbox({ accountStore, cache, imapConnect, parseMail, opTimeoutMs = 30000 }) {
  const conns = new Map(); // accountId → { conn, lastUsed }
  const readCache = new Map(); // `${accountId}|${folder}|${uid}` → read 结果（Map 迭代序即 LRU 序）

  async function connOf(accountId) {
    const hit = conns.get(accountId);
    if (hit && Date.now() - hit.lastUsed < IDLE_MS) { hit.lastUsed = Date.now(); return hit.conn; }
    if (hit) { await hit.conn.close().catch(() => undefined); conns.delete(accountId); }
    const acc = await accountStore.get(accountId);
    if (!acc) throw new Error(`账号不存在: ${accountId}`);
    const pw = await accountStore.getPassword(accountId);
    const conn = await imapConnect(acc, pw);
    conns.set(accountId, { conn, lastUsed: Date.now() });
    return conn;
  }
  // 超时守卫：操作落定即清计时器——裸 Promise.race 会在竞速失败侧遗留 reject，形成 unhandled rejection。
  const withTimeout = (label, p, ms = opTimeoutMs) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`IMAP ${label} 超时（${ms}ms）`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
  const readCacheGet = (key) => {
    const hit = readCache.get(key);
    if (!hit) return undefined;
    readCache.delete(key);
    readCache.set(key, hit);
    return hit;
  };
  const readCacheSet = (key, value) => {
    readCache.set(key, value);
    if (readCache.size > READ_CACHE_MAX) readCache.delete(readCache.keys().next().value);
  };

  const foldersCache = new Map(); // accountId → { value, at }

  async function probeFolders(accountId) {
    const conn = await connOf(accountId);
    const raw = await withTimeout('list', conn.list());
    const draftsCand = findFolder(raw, '\\Drafts', DRAFT_NAMES);
    const sentCand = findFolder(raw, '\\Sent', SENT_NAMES);
    const unseen = {};
    // status 一律 best-effort：目录名猜错（尤其 modified-UTF-7 的垃圾路径）不得让整个列表失败
    const statusOf = async (path) => {
      try {
        const st = await withTimeout('status', conn.status(path));
        unseen[path] = Number(st?.unseen ?? 0);
        return true;
      } catch {
        unseen[path] = 0;
        return false;
      }
    };
    const [, draftsOk, sentOk] = await Promise.all([
      statusOf('INBOX'),
      draftsCand ? statusOf(draftsCand) : Promise.resolve(false),
      sentCand ? statusOf(sentCand) : Promise.resolve(false),
    ]);
    return { all: raw, drafts: draftsOk ? draftsCand : null, sent: sentOk ? sentCand : null, unseen };
  }

  async function foldersImpl(accountId) {
    const hit = foldersCache.get(accountId);
    if (hit && Date.now() - hit.at < FOLDERS_TTL_MS) return hit.value;
    const value = await probeFolders(accountId);
    foldersCache.set(accountId, { value, at: Date.now() });
    return value;
  }

  async function envelopesImpl(accountId, folder, { page = 1, pageSize = 20, filter, force = false } = {}) {
    const size = Math.min(Math.max(Math.trunc(pageSize) || 20, 1), 50);
    const crit = {};
    if (filter) {
      if (filter.since) crit.since = filter.since;
      if (filter.unreadOnly) crit.unseen = true;
      if (filter.from) crit.from = filter.from;
      if (filter.subject) crit.subject = filter.subject;
    }
    // 带 filter 时缓存（无过滤全量）不适用，须直拉 IMAP；纯浏览走缓存优先。
    const hasFilter = Object.keys(crit).length > 0;
    let list;
    if (force || hasFilter) {
      const conn = await connOf(accountId);
      const uids = await withTimeout('search', conn.search(folder, crit));
      list = await withTimeout('fetch', conn.fetchEnvelopes(folder, uids));
      // 仅无过滤全量才落缓存——带 filter 的直拉结果写入共享槽会污染 5min TTL 内的无 filter 查询（2026-11-05 修复）。
      if (!hasFilter) cache.write(accountId, folder, list);
    } else {
      const cached = cache.read(accountId, folder);
      if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
        list = cached.items;
      } else {
        const conn = await connOf(accountId);
        const uids = await withTimeout('search', conn.search(folder, {}));
        list = await withTimeout('fetch', conn.fetchEnvelopes(folder, uids));
        cache.write(accountId, folder, list);
      }
    }
    // 列表恒为「uid 降序」（最新在前）——缓存/直拉统一排序后再分页，防最旧邮件顶到第一页。
    const sorted = [...list].sort((a, b) => b.uid - a.uid);
    const cur = Math.max(Math.trunc(page) || 1, 1);
    const start = (cur - 1) * size;
    return { items: sorted.slice(start, start + size), total: sorted.length, page: cur, pageSize: size };
  }

  async function readImpl(accountId, folder, uid) {
    const key = `${accountId}|${folder}|${uid}`;
    const cached = readCacheGet(key);
    if (cached) return cached;
    const conn = await connOf(accountId);
    const uids = await withTimeout('search', conn.search(folder, {}));
    const envs = await withTimeout('fetch', conn.fetchEnvelopes(folder, uids));
    const env = envs.find((e) => e.uid === uid);
    if (!env) throw new Error(`邮件不存在（folder=${folder} uid=${uid}）`);
    if ((env.size || 0) > READ_SOURCE_MAX) {
      throw new Error(`邮件体积 ${(env.size / 1048576).toFixed(1)}MB 超过 2MB 读取上限——附件请用 save_attachment`);
    }
    const source = await withTimeout('source', conn.fetchSource(folder, uid));
    const parsed = await parseMail(source);
    const text = String(parsed.text || '');
    const textTruncated = text.length > TEXT_TRUNCATE;
    const htmlRaw = typeof parsed.html === 'string' && parsed.html.trim() !== '' ? parsed.html : null;
    const htmlTruncated = htmlRaw != null && htmlRaw.length > TEXT_TRUNCATE;
    const view = {
      uid, subject: env.subject, from: env.from, to: env.to, date: env.date, seen: env.seen,
      text: textTruncated ? text.slice(0, TEXT_TRUNCATE) + '\n…（已截断，全文 200KB 上限）' : text,
      html: htmlTruncated ? htmlRaw.slice(0, TEXT_TRUNCATE) + '\n…（已截断，全文 200KB 上限）' : htmlRaw,
      truncated: textTruncated || htmlTruncated,
      attachments: (parsed.attachments || []).map((a) => ({
        partId: a.partId, filename: a.filename, contentType: a.contentType, size: a.content ? a.content.length : 0,
      })),
    };
    readCacheSet(key, view);
    return view;
  }

  async function attachmentImpl(accountId, folder, uid, partId) {
    const conn = await connOf(accountId);
    const uids = await withTimeout('search', conn.search(folder, {}));
    const envs = await withTimeout('fetch', conn.fetchEnvelopes(folder, uids));
    const env = envs.find((e) => e.uid === uid);
    if (env && (env.size || 0) > ATTACH_MAX) {
      throw new Error(`附件载体超过 10MB 上限（邮件 ${(env.size / 1048576).toFixed(1)}MB）`);
    }
    const source = await withTimeout('source', conn.fetchSource(folder, uid));
    const parsed = await parseMail(source);
    const att = (parsed.attachments || []).find((a) => a.partId === partId);
    if (!att) throw new Error(`附件不存在: partId=${partId}`);
    if (att.content.length > ATTACH_MAX) throw new Error(`附件超过 10MB 上限（${att.filename}）`);
    return { filename: att.filename, contentType: att.contentType, base64: att.content.toString('base64') };
  }

  return {
    CACHE_TTL_MS,
    // list + 3×status 在同一连接上串行（≈4 RTT），整链同样受单次调用总预算约束。
    folders: (accountId) => withTimeout('文件夹列表', foldersImpl(accountId)),
    invalidateFolders(accountId) { foldersCache.delete(accountId); },
    async draftsFolder(accountId) { return (await foldersImpl(accountId)).drafts ?? 'INBOX'; },
    async sentFolder(accountId) { return (await foldersImpl(accountId)).sent ?? 'INBOX'; },
    // 单次 service 调用总预算：整条链（选箱/search/fetch/parse）受 opTimeoutMs 约束，内部单操作超时保留。
    envelopes: (accountId, folder, opts) => withTimeout('列表', envelopesImpl(accountId, folder, opts)),
    read: (accountId, folder, uid) => withTimeout('读信', readImpl(accountId, folder, uid)),
    attachment: (accountId, folder, uid, partId) => withTimeout('取附件', attachmentImpl(accountId, folder, uid, partId)),
    async append(accountId, folder, raw) {
      const conn = await connOf(accountId);
      return withTimeout('append', conn.append(folder, raw));
    },
    // APPEND 响应可能不含 uid（QQ 实测只有 {destination,path}）——按报文内嵌标记反查，取最新（最大）uid。
    async resolveAppendedUid(accountId, folder, draftId) {
      const conn = await connOf(accountId);
      const uids = await withTimeout('定位草稿', conn.search(folder, { header: { 'X-Momo-Draft-Id': draftId } }));
      return (uids || []).reduce((max, u) => (Number(u) > max ? Number(u) : max), 0);
    },
    async deleteMessage(accountId, folder, uid) {
      const conn = await connOf(accountId);
      return withTimeout('delete', conn.deleteMessage(folder, uid));
    },
    async closeAll() {
      for (const { conn } of conns.values()) await conn.close().catch(() => undefined);
      conns.clear();
      readCache.clear();
    },
  };
}

module.exports = { createMailbox, CACHE_TTL_MS, FOLDERS_TTL_MS };
