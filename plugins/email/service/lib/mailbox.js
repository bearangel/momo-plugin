// mailbox：IMAP 域适配层。缓存优先（信封 TTL 5min）；正文/附件按需；全部操作 30s 超时。
// 连接复用：每账号一条，10min 空闲回收。
'use strict';

const { decodeModifiedUtf7 } = require('./utf7');

const CACHE_TTL_MS = 5 * 60 * 1000;
// 全源上限（读信与附件载体共用）：2026-11-11 由 2MB 提至 100MB，对齐公司内网邮件规格。
// 附件不再单设上限——附件不可能大于整封邮件，载体上限天然约束。
const READ_SOURCE_MAX = 100 * 1024 * 1024;
// 面板 patient 读信预算：大邮件慢链路需要；agent 路径仍走 opTimeoutMs（8s，先于宿主 callService 桥 10s 落定）。
const READ_PATIENT_MS = 25 * 1000;
const TEXT_TRUNCATE = 200 * 1024;           // 正文截断（面板视图；agent 视图另有 30K 预算，见 tools/read_mail.js）
const WARMUP_THRESHOLD = 20 * 1024 * 1024;  // 超此大小的未归档邮件，agent 读信走「后台预热 + deferred」而非同步拉取
const WARMUP_FETCH_TIMEOUT_MS = 10 * 60 * 1000; // 预热在 service 内部执行、不过桥，可给足慢链路预算
const WARMUP_BACKOFF_MS = 2 * 60 * 1000;    // 预热失败后的重触发退避（防工具轮询风暴打爆 IMAP 连接锁）
const IDLE_MS = 10 * 60 * 1000;             // 连接空闲回收
const READ_CACHE_MAX = 50;                  // 正文内存 LRU 容量
const FOLDERS_TTL_MS = 60 * 1000;           // 文件夹树缓存（切账号体感）
// 本地缓存保留时长（月=30天、半年=182天、年=365天，均为近似）。仅清理本地缓存，绝不动服务器。
const RETENTION_DAYS = { '1m': 30, '6m': 182, '1y': 365 };

function envelopeDateMs(e) {
  const t = Date.parse(e && e.date);
  return Number.isFinite(t) ? t : 0; // 0 = 日期未知 → 永不按龄清理
}

function filterByAge(list, cutoffMs) {
  if (cutoffMs == null) return list;
  return list.filter((e) => {
    const t = envelopeDateMs(e);
    return t === 0 || t >= cutoffMs;
  });
}

// 兜底名匹配统一走 norm（去空白+小写），故常量表预先归一——'Sent Items' 归一后是 'sentitems'。
const norm = (s) => String(s || '').toLowerCase().replace(/\s/g, '');
const DRAFT_NAMES = ['drafts', '草稿箱', '草稿', '草稿夹', '草稿邮件', 'draft'].map(norm);
const SENT_NAMES = ['sent', '已发送', '已发送邮件', '已发送邮件箱', '发件箱', 'sent messages', 'sent items'].map(norm);

function decodePath(p) { return String(p).split('/').map(decodeModifiedUtf7).join('/'); }

// 候选多选：specialUse 命中优先，其后是名称命中（原样/解码/末段）；去重保序供逐个探测。
function findFolders(raw, specialUse, names) {
  const out = [];
  const push = (p) => { if (typeof p === 'string' && p && !out.includes(p)) out.push(p); };
  for (const f of raw) if (f.specialUse === specialUse) push(f.path);
  const variants = (f) => [f.path, f.name]
    .filter((v) => typeof v === 'string')
    .flatMap((v) => {
      const d = decodeModifiedUtf7(v);
      return [norm(v), norm(d), norm(v.split('/').pop()), norm(d.split('/').pop())];
    });
  for (const f of raw) if (variants(f).some((v) => names.includes(v))) push(f.path);
  return out;
}

function createMailbox({ accountStore, cache, imapConnect, parseMail, store, archive, opTimeoutMs = 30000 }) {
  const conns = new Map(); // accountId → { conn, lastUsed }
  const readCache = new Map(); // `${accountId}|${folder}|${uid}` → read 结果（Map 迭代序即 LRU 序）
  const warmups = new Map(); // 同 key → { promise, at }：运行中去重；失败留 at 作退避锚点；成功即删（归档接管收敛）

  async function dropConn(accountId) {
    const hit = conns.get(accountId);
    conns.delete(accountId);
    if (hit) await hit.conn.close().catch(() => undefined);
  }

  async function connOf(accountId) {
    const hit = conns.get(accountId);
    if (hit && Date.now() - hit.lastUsed < IDLE_MS) {
      // 连接自愈：adapter 报告不可用（socket 已断/服务端关闭）→ 丢弃重建。
      if (typeof hit.conn.usable === 'function' && hit.conn.usable() === false) {
        await dropConn(accountId);
      } else {
        hit.lastUsed = Date.now();
        return hit.conn;
      }
    } else if (hit) {
      await dropConn(accountId);
    }
    const acc = await accountStore.get(accountId);
    if (!acc) throw new Error(`账号不存在: ${accountId}`);
    const pw = await accountStore.getPassword(accountId);
    const conn = await imapConnect(acc, pw);
    conns.set(accountId, { conn, lastUsed: Date.now() });
    return conn;
  }

  // 连接类错误（可重试一次）；业务错误（认证/邮件不存在等）原样抛。
  const CONN_ERROR_RE = /Connection not available|Not connected|Connection closed|ECONNRESET|socket/i;
  async function withConn(accountId, fn) {
    const conn = await connOf(accountId);
    try {
      return await fn(conn);
    } catch (err) {
      if (!CONN_ERROR_RE.test(String((err && err.message) || err))) throw err;
      await dropConn(accountId);
      return fn(await connOf(accountId));
    }
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

  // 按序探测候选：编码路径失败时回退解码路径（新浪 status 只认解码后的真实目录名）。
  async function resolveFolder(accountId, candidates, unseen) {
    for (const path of candidates) {
      const decoded = decodePath(path);
      const trials = decoded === path ? [path] : [path, decoded];
      for (const trial of trials) {
        try {
          const st = await withConn(accountId, (conn) => withTimeout('status', conn.status(trial)));
          unseen[trial] = Number(st?.unseen ?? 0);
          return trial;
        } catch {
          unseen[trial] = 0;
        }
      }
    }
    return null;
  }

  async function probeFolders(accountId) {
    const raw = await withConn(accountId, (conn) => withTimeout('list', conn.list()));
    const unseen = {};
    // status 一律 best-effort：目录名猜错（尤其 modified-UTF-7 的垃圾路径）不得让整个列表失败
    const [drafts, sent] = await Promise.all([
      resolveFolder(accountId, findFolders(raw, '\\Drafts', DRAFT_NAMES), unseen),
      resolveFolder(accountId, findFolders(raw, '\\Sent', SENT_NAMES), unseen),
      resolveFolder(accountId, ['INBOX'], unseen),
    ]).then(([d, s]) => [d, s]);
    const value = { all: raw, drafts, sent, unseen };
    try { store?.writeFoldersCache?.(accountId, value); } catch { /* 落库失败不影响在线结果 */ }
    return value;
  }

  async function foldersImpl(accountId) {
    const hit = foldersCache.get(accountId);
    if (hit && Date.now() - hit.at < FOLDERS_TTL_MS) return hit.value;
    const value = await probeFolders(accountId);
    foldersCache.set(accountId, { value, at: Date.now() });
    return value;
  }

  function localFolders(accountId) {
    const mem = foldersCache.get(accountId);
    if (mem) return mem.value;
    const hit = store?.readFoldersCache?.(accountId);
    return hit ? hit.value : null;
  }

  async function foldersPeek(accountId) {
    const mem = foldersCache.get(accountId);
    if (mem) return { value: mem.value, savedAt: mem.at };
    const hit = store?.readFoldersCache?.(accountId);
    if (hit) return { value: hit.value, savedAt: hit.savedAt };
    return { value: null, savedAt: null };
  }

  // 保留策略：只作用于本地缓存；Sent 永久；sent 探测失败/找不到 → 不清理（fail-safe）。
  async function retentionCutoff(accountId, folder, { localOnly = false } = {}) {
    const acc = await accountStore.get(accountId);
    const retention = (acc && acc.retention) || 'forever';
    if (retention === 'forever') return null;
    try {
      const folders = localOnly ? localFolders(accountId) : await foldersImpl(accountId);
      const sent = folders && folders.sent;
      if (!sent || folder === sent) return null;
      const days = RETENTION_DAYS[retention];
      return days ? Date.now() - days * 86400000 : null;
    } catch {
      return null;
    }
  }

  const fetchEnvelopesNow = (accountId, folder, crit) => withConn(accountId, async (conn) => {
    const uids = await withTimeout('search', conn.search(folder, crit));
    return withTimeout('fetch', conn.fetchEnvelopes(folder, uids));
  });

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
    const cutoffMs = await retentionCutoff(accountId, folder);
    let list;
    if (force || hasFilter) {
      list = await fetchEnvelopesNow(accountId, folder, crit);
      // 仅无过滤全量才落缓存——带 filter 的直拉结果写入共享槽会污染 5min TTL 内的无 filter 查询（2026-11-05 修复）。
      if (!hasFilter) cache.write(accountId, folder, list, { cutoffMs });
    } else {
      const cached = cache.read(accountId, folder);
      if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
        list = cached.items;
      } else {
        list = await fetchEnvelopesNow(accountId, folder, {});
        cache.write(accountId, folder, list, { cutoffMs });
      }
    }
    // 读缓存同样按当前配置过滤（改小保留期后立即生效，不必等下次重写）。
    list = filterByAge(list, cutoffMs);
    // 列表恒为「uid 降序」（最新在前）——缓存/直拉统一排序后再分页，防最旧邮件顶到第一页。
    const sorted = [...list].sort((a, b) => b.uid - a.uid);
    const cur = Math.max(Math.trunc(page) || 1, 1);
    const start = (cur - 1) * size;
    return { items: sorted.slice(start, start + size), total: sorted.length, page: cur, pageSize: size };
  }

  function buildReadView(uid, env, parsed) {
    const text = String(parsed.text || '');
    const textTruncated = text.length > TEXT_TRUNCATE;
    const htmlRaw = typeof parsed.html === 'string' && parsed.html.trim() !== '' ? parsed.html : null;
    const htmlTruncated = htmlRaw != null && htmlRaw.length > TEXT_TRUNCATE;
    return {
      uid, subject: env.subject, from: env.from, to: env.to, date: env.date, seen: env.seen,
      text: textTruncated ? text.slice(0, TEXT_TRUNCATE) + '\n…（已截断，全文 200KB 上限）' : text,
      // textChars/htmlChars/imageCount：截断前的全文统计，agent 视图据此告知「图多/正文长」而不下发原文
      textChars: text.length,
      htmlChars: htmlRaw ? htmlRaw.length : 0,
      imageCount: htmlRaw ? (htmlRaw.match(/<img\b/gi) || []).length : 0,
      html: htmlTruncated ? htmlRaw.slice(0, TEXT_TRUNCATE) + '\n…（已截断，全文 200KB 上限）' : htmlRaw,
      truncated: textTruncated || htmlTruncated,
      attachments: (parsed.attachments || []).map((a) => ({
        partId: a.partId, filename: a.filename, contentType: a.contentType, size: a.content ? a.content.length : 0,
      })),
    };
  }

  // 归档信封兜底：信封缓存缺失时自解析补 subject/from/to/date（seen 不可知按 false）
  const envOfParsed = (uid, parsed) => ({
    uid,
    subject: parsed.subject ?? '',
    from: parsed.from?.text ?? '',
    to: parsed.to?.text ?? '',
    date: parsed.date instanceof Date ? parsed.date.toISOString() : (parsed.date ?? null),
    seen: false,
  });

  // 读信成功即标已读（best-effort，不阻断读信返回）：
  // ImapFlow fetch 全走 BODY.PEEK（刻意不置 \Seen），若无此步服务器与本地信封缓存将永远「未读」。
  // 离线归档读/标记失败 → 静默放弃（返回 false），下次读信或刷新自然重试。
  function markSeenAndSync(accountId, folder, uid, alreadySeen) {
    if (alreadySeen) return Promise.resolve(false);
    return withConn(accountId, (conn) => withTimeout('标记已读', conn.markSeen(folder, uid)))
      .then(() => {
        const cached = cache.read(accountId, folder);
        if (cached && cached.items.some((e) => Number(e.uid) === uid)) {
          cache.write(accountId, folder, cached.items.map((e) => (Number(e.uid) === uid ? { ...e, seen: true } : e)));
        }
        return true;
      })
      .catch(() => false); // best-effort：离线归档读/标记失败不阻断
  }

  // 后台预热：拉源直落归档（不解析——解析留给收敛后的归档快路径读）。
  // 不过桥、不受单次调用预算约束（自有 10min 预算）；成功即删条目（归档命中接管收敛），
  // 失败保留条目至退避窗口过期——轮询方每 3s 重试读信时不会重复触发新预热打爆连接锁。
  function triggerWarmup(accountId, folder, uid) {
    const key = `${accountId}|${folder}|${uid}`;
    const hit = warmups.get(key);
    if (hit && Date.now() - hit.at < WARMUP_BACKOFF_MS) return hit.promise;
    const entry = { promise: null, at: Date.now() };
    entry.promise = withConn(accountId, async (conn) => {
      const source = await withTimeout('预热', conn.fetchSource(folder, uid), WARMUP_FETCH_TIMEOUT_MS);
      if (archive) await archive.write(accountId, folder, uid, source, 0);
    })
      .then(() => { warmups.delete(key); return 'done'; })
      .catch(() => 'failed');
    warmups.set(key, entry);
    return entry.promise;
  }

  async function readImpl(accountId, folder, uid, opts = {}) {
    const key = `${accountId}|${folder}|${uid}`;
    const cached = readCacheGet(key);
    if (cached) return cached;
    if (archive) {
      const hit = await archive.read(accountId, folder, uid);
      if (hit) {
        if (hit.raw.length > READ_SOURCE_MAX) {
          throw new Error(`邮件体积 ${(hit.raw.length / 1048576).toFixed(1)}MB 超过 100MB 读取上限`);
        }
        const parsed = await parseMail(hit.raw);
        const env = cache.read(accountId, folder)?.items.find((e) => Number(e.uid) === uid) ?? envOfParsed(uid, parsed);
        const view = buildReadView(uid, env, parsed);
        void markSeenAndSync(accountId, folder, uid, env.seen === true).catch(() => undefined);
        readCacheSet(key, view);
        return view;
      }
    }
    // 在线路径只拉目标单封（fetchOne），不再 search 全量 uid + fetch 全量信封——万级邮箱下每次读信全量拉信封不可承受。
    const env = await withConn(accountId, (conn) => withTimeout('信封', conn.fetchEnvelope(folder, uid)));
    if (!env) throw new Error(`邮件不存在（folder=${folder} uid=${uid}）`);
    if ((env.size || 0) > READ_SOURCE_MAX) {
      throw new Error(`邮件体积 ${(env.size / 1048576).toFixed(1)}MB 超过 100MB 读取上限`);
    }
    // 大邮件异步预热（agent 读信 opt-in）：立即返回 deferred 让桥秒回，后台拉源落归档；
    // 调用方轮询重读 → 命中归档快路径收敛。estimateSec 按 ~10Mbps 慢链路保守估。
    if (opts.warmup === true && (env.size || 0) > WARMUP_THRESHOLD) {
      void triggerWarmup(accountId, folder, uid);
      return {
        deferred: true, uid,
        sizeBytes: env.size || 0,
        estimateSec: Math.max(5, Math.ceil((env.size || 0) / (1.2 * 1024 * 1024))),
      };
    }
    const source = await withConn(accountId, (conn) => withTimeout('source', conn.fetchSource(folder, uid)));
    const parsed = await parseMail(source);
    const view = buildReadView(uid, env, parsed);
    if (archive) {
      void archive.write(accountId, folder, uid, source, Date.parse(env.date) || 0).catch(() => undefined);
    }
    void markSeenAndSync(accountId, folder, uid, env.seen === true).catch(() => undefined);
    readCacheSet(key, view);
    return view;
  }

  async function attachmentImpl(accountId, folder, uid, partId) {
    const findAtt = (parsed) => (parsed.attachments || []).find((a) => a.partId === partId);
    if (archive) {
      const hit = await archive.read(accountId, folder, uid);
      if (hit && hit.raw.length <= READ_SOURCE_MAX) {
        const parsed = await parseMail(hit.raw);
        const att = findAtt(parsed);
        // 返回 content Buffer（调用方 service 侧经临时文件中转交付，不再 base64 过 RPC 桥）
        if (att) return { filename: att.filename, contentType: att.contentType, content: att.content };
      }
    }
    const source = await withConn(accountId, async (conn) => {
      const env = await withTimeout('信封', conn.fetchEnvelope(folder, uid));
      if (env && (env.size || 0) > READ_SOURCE_MAX) {
        throw new Error(`附件载体超过 100MB 上限（邮件 ${(env.size / 1048576).toFixed(1)}MB）`);
      }
      return withTimeout('source', conn.fetchSource(folder, uid));
    });
    if (archive) {
      void archive.write(accountId, folder, uid, source, 0).catch(() => undefined);
    }
    const parsed = await parseMail(source);
    const att = findAtt(parsed);
    if (!att) throw new Error(`附件不存在: partId=${partId}`);
    return { filename: att.filename, contentType: att.contentType, content: att.content };
  }

  return {
    CACHE_TTL_MS,
    // list + 3×status 在同一连接上串行（≈4 RTT），整链同样受单次调用总预算约束。
    folders: (accountId) => withTimeout('文件夹列表', foldersImpl(accountId)),
    invalidateFolders(accountId) { foldersCache.delete(accountId); },
    // 草稿箱识别失败必须失败退出：回退 INBOX 会把草稿写进收件箱（比失败更糟）。
    async draftsFolder(accountId) {
      const folder = (await foldersImpl(accountId)).drafts;
      if (!folder) {
        throw new Error('未能识别该邮箱的草稿箱文件夹（服务商目录名非标准）。请在面板确认邮箱文件夹，或改用 INBOX 中手动起草。');
      }
      return folder;
    },
    async sentFolder(accountId) { return (await foldersImpl(accountId)).sent; },
    foldersPeek,
    retentionCutoff,
    // 本地优先读取：不触 IMAP、忽略 TTL；无缓存返回空页。
    async envelopesPeek(accountId, folder, { page = 1, pageSize = 20 } = {}) {
      const size = Math.min(Math.max(Math.trunc(pageSize) || 20, 1), 50);
      const cur = Math.max(Math.trunc(page) || 1, 1);
      const cached = cache.read(accountId, folder);
      if (!cached) return { items: [], total: 0, page: cur, pageSize: size, savedAt: null };
      const cutoffMs = await retentionCutoff(accountId, folder, { localOnly: true });
      const sorted = [...filterByAge(cached.items, cutoffMs)].sort((a, b) => b.uid - a.uid);
      const start = (cur - 1) * size;
      return { items: sorted.slice(start, start + size), total: sorted.length, page: cur, pageSize: size, savedAt: cached.savedAt };
    },
    // 单次 service 调用总预算：整条链（选箱/search/fetch/parse）受 opTimeoutMs 约束，内部单操作超时保留。
    envelopes: (accountId, folder, opts) => withTimeout('列表', envelopesImpl(accountId, folder, opts)),
    // opts.patient：面板大邮件慢链路用 25s 预算；默认 8s（agent 路径先于宿主桥 10s 落定）
    // opts.warmup：agent 读信专用——超阈值未归档邮件返回 deferred 而非同步拉取
    read: (accountId, folder, uid, opts) => withTimeout('读信', readImpl(accountId, folder, uid, opts),
      opts && opts.patient ? READ_PATIENT_MS : opTimeoutMs),
    attachment: (accountId, folder, uid, partId) => withTimeout('取附件', attachmentImpl(accountId, folder, uid, partId)),
    async append(accountId, folder, raw) {
      return withConn(accountId, (conn) => withTimeout('append', conn.append(folder, raw)));
    },
    // APPEND 响应可能不含 uid（QQ 实测只有 {destination,path}）——按报文内嵌标记反查，取最新（最大）uid。
    async resolveAppendedUid(accountId, folder, draftId) {
      const uids = await withConn(accountId, (conn) => withTimeout('定位草稿', conn.search(folder, { header: { 'X-Momo-Draft-Id': draftId } })));
      return (uids || []).reduce((max, u) => (Number(u) > max ? Number(u) : max), 0);
    },
    async deleteMessage(accountId, folder, uid) {
      return withConn(accountId, (conn) => withTimeout('delete', conn.deleteMessage(folder, uid)));
    },
    async closeAll() {
      for (const { conn } of conns.values()) await conn.close().catch(() => undefined);
      conns.clear();
      readCache.clear();
    },
  };
}

module.exports = { createMailbox, findFolders, CACHE_TTL_MS, FOLDERS_TTL_MS, READ_SOURCE_MAX, READ_PATIENT_MS, WARMUP_THRESHOLD };
