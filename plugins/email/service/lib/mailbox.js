// mailbox：IMAP 域适配层。缓存优先（信封 TTL 5min）；正文/附件按需；全部操作 30s 超时。
// 连接复用：每账号一条，10min 空闲回收。
'use strict';

const CACHE_TTL_MS = 5 * 60 * 1000;
const READ_SOURCE_MAX = 2 * 1024 * 1024;   // read_mail 全源上限
const TEXT_TRUNCATE = 200 * 1024;           // 正文截断
const ATTACH_MAX = 10 * 1024 * 1024;        // 附件 RPC 上限
const IDLE_MS = 10 * 60 * 1000;             // 连接空闲回收

// 兜底名匹配统一走 norm（去空白+小写），故常量表预先归一——'Sent Items' 归一后是 'sentitems'。
const norm = (s) => String(s || '').toLowerCase().replace(/\s/g, '');
const DRAFT_NAMES = ['drafts', '草稿箱', '草稿', 'draft'].map(norm);
const SENT_NAMES = ['sent', '已发送', '已发送邮件', 'sent messages', 'sent items'].map(norm);

function createMailbox({ accountStore, cache, imapConnect, parseMail, opTimeoutMs = 30000 }) {
  const conns = new Map(); // accountId → { conn, lastUsed }

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
  const withTimeout = (label, p) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`IMAP ${label} 超时（${opTimeoutMs}ms）`)), opTimeoutMs);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });

  async function foldersImpl(accountId) {
    const conn = await connOf(accountId);
    const raw = await withTimeout('list', conn.list());
    const drafts = raw.find((f) => f.specialUse === '\\Drafts')?.path
      ?? raw.find((f) => DRAFT_NAMES.includes(norm(f.path)))?.path ?? null;
    const sent = raw.find((f) => f.specialUse === '\\Sent')?.path
      ?? raw.find((f) => SENT_NAMES.includes(norm(f.path)))?.path ?? null;
    return { all: raw, drafts, sent };
  }

  return {
    CACHE_TTL_MS,
    folders: foldersImpl,
    async draftsFolder(accountId) { return (await foldersImpl(accountId)).drafts ?? 'INBOX'; },
    async sentFolder(accountId) { return (await foldersImpl(accountId)).sent ?? 'INBOX'; },
    async envelopes(accountId, folder, { page = 1, pageSize = 20, filter, force = false } = {}) {
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
      const cur = Math.max(Math.trunc(page) || 1, 1);
      const start = (cur - 1) * size;
      return { items: list.slice(start, start + size), total: list.length, page: cur, pageSize: size };
    },
    async read(accountId, folder, uid) {
      const conn = await connOf(accountId);
      const uids = await withTimeout('search', conn.search(folder, {}));
      const envs = await withTimeout('fetch', conn.fetchEnvelopes(folder, uids));
      const env = envs.find((e) => e.uid === uid);
      if (!env) throw new Error(`邮件不存在（folder=${folder} uid=${uid}）`);
      if ((env.size || 0) > READ_SOURCE_MAX) {
        throw new Error(`邮件体积 ${(env.size / 1048576).toFixed(1)}MB 超过 2MB 读取上限——附件请用 save_attachment`);
      }
      const source = await withTimeout('source', conn.fetchSource(uid));
      const parsed = await parseMail(source);
      const text = String(parsed.text || '');
      const truncated = text.length > TEXT_TRUNCATE;
      return {
        uid, subject: env.subject, from: env.from, to: env.to, date: env.date, seen: env.seen,
        text: truncated ? text.slice(0, TEXT_TRUNCATE) + '\n…（已截断，全文 200KB 上限）' : text,
        html: parsed.html || null, truncated,
        attachments: (parsed.attachments || []).map((a) => ({
          partId: a.partId, filename: a.filename, contentType: a.contentType, size: a.content ? a.content.length : 0,
        })),
      };
    },
    async attachment(accountId, folder, uid, partId) {
      const conn = await connOf(accountId);
      const uids = await withTimeout('search', conn.search(folder, {}));
      const envs = await withTimeout('fetch', conn.fetchEnvelopes(folder, uids));
      const env = envs.find((e) => e.uid === uid);
      if (env && (env.size || 0) > ATTACH_MAX) {
        throw new Error(`附件载体超过 10MB 上限（邮件 ${(env.size / 1048576).toFixed(1)}MB）`);
      }
      const source = await withTimeout('source', conn.fetchSource(uid));
      const parsed = await parseMail(source);
      const att = (parsed.attachments || []).find((a) => a.partId === partId);
      if (!att) throw new Error(`附件不存在: partId=${partId}`);
      if (att.content.length > ATTACH_MAX) throw new Error(`附件超过 10MB 上限（${att.filename}）`);
      return { filename: att.filename, contentType: att.contentType, base64: att.content.toString('base64') };
    },
    async append(accountId, folder, raw) {
      const conn = await connOf(accountId);
      return withTimeout('append', conn.append(folder, raw));
    },
    async deleteMessage(accountId, folder, uid) {
      const conn = await connOf(accountId);
      return withTimeout('delete', conn.deleteMessage(folder, uid));
    },
    async closeAll() {
      for (const { conn } of conns.values()) await conn.close().catch(() => undefined);
      conns.clear();
    },
  };
}

module.exports = { createMailbox, CACHE_TTL_MS };
