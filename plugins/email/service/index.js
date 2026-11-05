// email service：createService(ctx)（宿主契约）→ buildService 内核（依赖注入可测）。
// 不 require electron/宿主内部模块；vendor 相对路径引入。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createAccountStore } = require('./lib/accounts');
const { createStore } = require('./lib/store');
const { createEnvelopeCache } = require('./lib/envelope-cache');
const { createMailbox } = require('./lib/mailbox');
const { createDrafts } = require('./lib/drafts');
const { renderRawMail } = require('./lib/rfc822');

function vendor(name) { return require(path.join(__dirname, '..', 'vendor', 'node_modules', name)); }

const TLS_MODES = ['tls', 'starttls'];

/** 端点校验（与 lib/accounts.js add 侧同规则——明文连接不可能构造） */
function assertEndpoint(label, ep) {
  if (!ep || typeof ep.host !== 'string' || ep.host.trim() === '') throw new Error(`${label}.host 不能为空`);
  if (!Number.isInteger(ep.port) || ep.port < 1 || ep.port > 65535) {
    throw new Error(`${label} 端口非法（${ep && ep.port}）`);
  }
  if (!TLS_MODES.includes(ep.tlsMode)) {
    throw new Error(`${label}.tlsMode 必须是 tls/starttls（明文连接拒绝）`);
  }
}

/** smtp transport 构造（tlsMode 映射强制加密——明文不可能构造） */
function smtpTransportOf(nodemailerLib, acc, pw) {
  return acc.smtp.tlsMode === 'tls'
    ? nodemailerLib.createTransport({ host: acc.smtp.host, port: acc.smtp.port, secure: true, auth: { user: acc.username, pass: pw } })
    : nodemailerLib.createTransport({ host: acc.smtp.host, port: acc.smtp.port, secure: false, requireTLS: true, auth: { user: acc.username, pass: pw } });
}

/** ImapFlow → mailbox adapter 契约 */
// 部分服务商（新浪等）把 modified-UTF-7 编码的普通文件夹名当 NAMESPACE prefix，
// imapflow 会据此把每个路径拼成不存在的层级——含 '&' 的前缀一律按无前缀处理。
function shouldResetNamespace(prefix) {
  return typeof prefix === 'string' && prefix.includes('&');
}

function imapAdapterFor(ImapFlow) {
  return async (account, password) => {
    const secure = account.imap.tlsMode === 'tls';
    const client = new ImapFlow({
      host: account.imap.host, port: account.imap.port, secure,
      requireTLS: !secure,
      auth: { user: account.username, pass: password },
      logger: false,
    });
    await client.connect();
    if (client.namespace && shouldResetNamespace(client.namespace.prefix)) {
      client.namespace = { prefix: '', delimiter: client.namespace.delimiter || '/' };
    }
    // 选箱纪律：ImapFlow 在未选箱（this.mailbox === false）时 search/fetch/fetchOne 直接空返回，
    // 且 folder 不是这些方法的合法参数（会被静默忽略）——每次按 folder 操作必须显式取锁选箱。
    const withMailbox = async (folder, fn) => {
      const lock = await client.getMailboxLock(folder);
      try { return await fn(); } finally { lock.release(); }
    };
    return {
      list: async () => (await client.list()).map((f) => ({ path: f.path, specialUse: f.specialUse || null })),
      search: async (folder, crit) => {
        const s = { ...crit };
        if (crit.header) s.header = { ...crit.header };
        if (Object.keys(s).length === 0) s.all = true;
        return withMailbox(folder, async () => (await client.search(s, { uid: true })) ?? []);
      },
      fetchEnvelopes: async (folder, uids) => withMailbox(folder, async () => {
        const out = [];
        for await (const msg of client.fetch(uids, { envelope: true, bodyStructure: true, size: true }, { uid: true })) {
          out.push({
            uid: msg.uid,
            subject: msg.envelope?.subject ?? '',
            from: msg.envelope?.from?.[0]?.address ?? '',
            to: msg.envelope?.to?.[0]?.address ?? '',
            date: msg.envelope?.date?.toISOString?.() ?? null,
            seen: Boolean(msg.flags?.has?.('\\Seen')),
            hasAttachments: Boolean(msg.bodyStructure?.childNodes?.some?.((c) => c.disposition === 'attachment')),
            size: msg.size ?? 0,
          });
        }
        return out;
      }),
      fetchSource: async (folder, uid) => withMailbox(folder, async () => {
        const r = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!r || !r.source) throw new Error('邮件源获取失败');
        return r.source;
      }),
      status: async (folder) => client.status(folder, { unseen: true }),
      append: async (folder, raw) => (await client.append(folder, raw))?.uid ?? 0,
      deleteMessage: async (folder, uid) => withMailbox(folder, async () => {
        await client.messageDelete(String(uid), { uid: true });
      }),
      close: async () => { await client.logout().catch(() => client.close?.()); },
    };
  };
}

// 认证类失败识别：命中则标记账号健康态（spec §10），下次列表即显红点。
const AUTH_FAIL_RE = /AUTHENTICATIONFAILED|LOGIN failed|authenticate|Invalid credentials|535/i;

function buildService(deps) {
  const { dataDir, secrets, logger } = deps;
  const smtpTimeoutMs = deps.smtpTimeoutMs ?? 8000;
  fs.mkdirSync(dataDir, { recursive: true });
  const accountStore = createAccountStore({ dataDir, secrets });
  const store = createStore({ dataDir });
  const cache = createEnvelopeCache({ store });
  const imapConnect = deps.imapConnect ?? imapAdapterFor(deps.imapflow);
  const parseMail = deps.parseMail ?? ((src) => deps.mailparserLib.simpleParser(src));
  // 桥超时对齐：宿主 callService 桥 requestPluginCallService 超时 10s
  // （momo-studio electron/src/main/agent/plugin-hook-bridge.ts，2026-11-05 实测 < 30s），
  // IMAP 慢操作须先于桥超时落定并给出中文错误——opTimeoutMs = 桥超时 − 2s = 8s。
  const mailbox = createMailbox({ accountStore, cache, imapConnect, parseMail, opTimeoutMs: 8000 });
  // SMTP/连通性探测超时：默认 8s（先于宿主 callService 桥 10s 落定，文案含「超时」）。
  const smtpGuard = (label, p, ms = smtpTimeoutMs) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`SMTP ${label} 超时（${ms}ms）`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
  const withHealth = async (accountId, fn) => {
    try {
      return await fn();
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (accountId && AUTH_FAIL_RE.test(msg)) {
        await accountStore.markHealth(accountId, 'error', msg).catch(() => undefined);
      }
      throw err;
    }
  };
  const renderMail = async (input) => renderRawMail({ nodemailerLib: deps.nodemailerLib, ...input });
  const smtpSend = async (accountId, raw, envelope) => {
    const acc = await accountStore.get(accountId);
    const pw = await accountStore.getPassword(accountId);
    await smtpGuard('发送', smtpTransportOf(deps.nodemailerLib, acc, pw).sendMail({ raw, envelope }));
  };
  const drafts = createDrafts({ store, cache, renderMail, smtpSend, mailbox });

  const ROUTES = {
    'accounts.list': () => accountStore.list(),
    'accounts.add': (p) => accountStore.add(p),
    'accounts.update': async (p) => {
      const r = await accountStore.update(p.id, p.patch ?? {});
      mailbox.invalidateFolders(p.id);
      return r;
    },
    'accounts.delete': async (p) => {
      const r = await accountStore.remove(p.id);
      mailbox.invalidateFolders(p.id);
      return r;
    },
    'accounts.test': async (p) => {
      const acc = (await accountStore.list()).find((a) => a.email === p.email);
      // 先测后存：表单直测（账号尚未落库）——用入参临时探测，不写 accounts.json、不写 secrets
      if (!acc && p.imap && p.smtp) {
        assertEndpoint('imap', p.imap);
        assertEndpoint('smtp', p.smtp);
        const probe = {
          email: p.email,
          username: p.username || p.email,
          imap: { host: p.imap.host, port: p.imap.port, tlsMode: p.imap.tlsMode },
          smtp: { host: p.smtp.host, port: p.smtp.port, tlsMode: p.smtp.tlsMode },
        };
        try {
          const conn = await smtpGuard('IMAP 连接', imapConnect(probe, p.password));
          await conn.close();
          await smtpGuard('验证', smtpTransportOf(deps.nodemailerLib, probe, p.password).verify());
          return { ok: true };
        } catch (err) {
          return { ok: false, error: String((err && err.message) || err) };
        }
      }
      if (!acc) throw new Error(`账号不存在: ${p.email}`);
      // 编辑态可传新密码直测；留空则用已存密码。
      const pw = (typeof p.password === 'string' && p.password !== '')
        ? p.password
        : await accountStore.getPassword(acc.id);
      try {
        const conn = await smtpGuard('IMAP 连接', imapConnect(acc, pw));
        await conn.close();
        await smtpGuard('验证', smtpTransportOf(deps.nodemailerLib, acc, pw).verify());
        await accountStore.markHealth(acc.id, 'ok');
        return { ok: true };
      } catch (err) {
        const msg = String((err && err.message) || err);
        await accountStore.markHealth(acc.id, 'error', msg);
        return { ok: false, error: msg };
      }
    },
    'folders.list': (p) => withHealth(p.accountId, () => mailbox.folders(p.accountId)),
    'mails.list': (p) => withHealth(p.accountId, () => mailbox.envelopes(p.accountId, p.folder ?? 'INBOX',
      { page: p.page, pageSize: p.pageSize, filter: p.filter, force: false })),
    'mails.refresh': (p) => withHealth(p.accountId, () => mailbox.envelopes(p.accountId, p.folder ?? 'INBOX',
      { force: true, filter: p.filter, page: p.page, pageSize: p.pageSize })),
    'mails.get': (p) => withHealth(p.accountId, () => mailbox.read(p.accountId, p.folder, p.uid)),
    'attachments.get': (p) => withHealth(p.accountId, () => mailbox.attachment(p.accountId, p.folder, p.uid, p.partId)),
    'drafts.save': async (p) => {
      // '__first__' = 工具侧首账号回退哨兵（draft_mail 未指定 accountId 时）
      let accountId = p.accountId;
      if (accountId === '__first__') {
        const first = (await accountStore.list())[0];
        if (!first) throw new Error('尚未配置邮箱账号');
        accountId = first.id;
      }
      const account = await accountStore.get(accountId);
      if (!account) throw new Error(`账号不存在: ${accountId}`);
      return drafts.save({
        accountId, account,
        to: Array.isArray(p.to) ? p.to : (typeof p.to === 'string' ? [p.to] : []),
        cc: Array.isArray(p.cc) ? p.cc : [],
        subject: String(p.subject || ''), text: String(p.text || ''),
        attachments: (p.attachments || []).map((a) => ({
          filename: a.filename, contentType: a.contentType, data: Buffer.from(a.base64, 'base64'),
        })),
      });
    },
    'drafts.list': () => drafts.list(),
    'drafts.send': (p) => drafts.send(p.draftId),
    'drafts.discard': (p) => drafts.discard(p.draftId),
  };

  return {
    async start() { await drafts.sweep(); logger.info?.('email service started'); },
    async stop() {
      await mailbox.closeAll();
      store.close();
    },
    async handle(method, params) {
      const fn = ROUTES[method];
      if (!fn) throw new Error(`未知方法: ${method}`);
      return fn(params ?? {});
    },
  };
}

/** 宿主入口（service-manager createRequire 装载） */
module.exports.createService = function createService(ctx) {
  const svc = buildService({
    dataDir: ctx.getDataDir(),
    secrets: ctx.secrets,
    logger: ctx.logger,
    imapflow: vendor('imapflow').ImapFlow,
    nodemailerLib: vendor('nodemailer'),
    mailparserLib: vendor('mailparser'),
  });
  return {
    start: () => svc.start().catch((err) => { ctx.logger.error('email service start 失败: ' + err.message); }),
    stop: () => svc.stop(),
    handle: (method, params) => svc.handle(method, params),
  };
};
module.exports.buildService = buildService;
module.exports.shouldResetNamespace = shouldResetNamespace;
