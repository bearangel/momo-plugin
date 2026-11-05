// email service：createService(ctx)（宿主契约）→ buildService 内核（依赖注入可测）。
// 不 require electron/宿主内部模块；vendor 相对路径引入。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createAccountStore } = require('./lib/accounts');
const { createEnvelopeCache } = require('./lib/envelope-cache');
const { createMailbox } = require('./lib/mailbox');
const { createDrafts } = require('./lib/drafts');
const { renderRawMail } = require('./lib/rfc822');

function vendor(name) { return require(path.join(__dirname, '..', 'vendor', 'node_modules', name)); }

/** smtp transport 构造（tlsMode 映射强制加密——明文不可能构造） */
function smtpTransportOf(nodemailerLib, acc, pw) {
  return acc.smtp.tlsMode === 'tls'
    ? nodemailerLib.createTransport({ host: acc.smtp.host, port: acc.smtp.port, secure: true, auth: { user: acc.username, pass: pw } })
    : nodemailerLib.createTransport({ host: acc.smtp.host, port: acc.smtp.port, secure: false, requireTLS: true, auth: { user: acc.username, pass: pw } });
}

/** ImapFlow → mailbox adapter 契约 */
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
    return {
      list: async () => (await client.list()).map((f) => ({ path: f.path, specialUse: f.specialUse || null })),
      search: async (folder, crit) => {
        const s = { ...crit };
        if (Object.keys(s).length === 0) s.all = true;
        return client.search({ folder, ...s }, { uid: true }) ?? [];
      },
      fetchEnvelopes: async (folder, uids) => {
        const out = [];
        for await (const msg of client.fetch(uids, { envelope: true, bodyStructure: true, size: true }, { folder, uid: true })) {
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
      },
      fetchSource: async (uid) => {
        const r = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!r || !r.source) throw new Error('邮件源获取失败');
        return r.source;
      },
      status: async (folder) => client.status(folder, { unseen: true }),
      append: async (folder, raw) => (await client.append(folder, raw))?.uid ?? 0,
      deleteMessage: async (folder, uid) => { await client.messageDelete(String(uid), { folder, uid: true }); },
      close: async () => { await client.logout().catch(() => client.close?.()); },
    };
  };
}

function buildService(deps) {
  const { dataDir, secrets, logger } = deps;
  fs.mkdirSync(dataDir, { recursive: true });
  const accountStore = createAccountStore({ dataDir, secrets });
  const cache = createEnvelopeCache({ dataDir });
  const imapConnect = deps.imapConnect ?? imapAdapterFor(deps.imapflow);
  const parseMail = deps.parseMail ?? ((src) => deps.mailparserLib.simpleParser(src));
  // 桥超时对齐：宿主 callService 桥 requestPluginCallService 超时 10s
  // （momo-studio electron/src/main/agent/plugin-hook-bridge.ts，2026-11-05 实测 < 30s），
  // IMAP 慢操作须先于桥超时落定并给出中文错误——opTimeoutMs = 桥超时 − 2s = 8s。
  const mailbox = createMailbox({ accountStore, cache, imapConnect, parseMail, opTimeoutMs: 8000 });
  const renderMail = async (input) => renderRawMail({ nodemailerLib: deps.nodemailerLib, ...input });
  const smtpSend = async (accountId, raw, envelope) => {
    const acc = await accountStore.get(accountId);
    const pw = await accountStore.getPassword(accountId);
    await smtpTransportOf(deps.nodemailerLib, acc, pw).sendMail({ raw, envelope });
  };
  const drafts = createDrafts({ dataDir, renderMail, smtpSend, mailbox });

  const ROUTES = {
    'accounts.list': () => accountStore.list(),
    'accounts.add': (p) => accountStore.add(p),
    'accounts.update': (p) => accountStore.update(p.id, p.patch ?? {}),
    'accounts.delete': (p) => accountStore.remove(p.id),
    'accounts.test': async (p) => {
      const acc = (await accountStore.list()).find((a) => a.email === p.email);
      if (!acc) throw new Error(`账号不存在: ${p.email}`);
      const pw = await accountStore.getPassword(acc.id);
      try {
        const conn = await imapConnect(acc, pw);
        await conn.close();
        await smtpTransportOf(deps.nodemailerLib, acc, pw).verify();
        await accountStore.markHealth(acc.id, 'ok');
        return { ok: true };
      } catch (err) {
        const msg = String((err && err.message) || err);
        await accountStore.markHealth(acc.id, 'error', msg);
        return { ok: false, error: msg };
      }
    },
    'folders.list': (p) => mailbox.folders(p.accountId),
    'mails.list': (p) => mailbox.envelopes(p.accountId, p.folder ?? 'INBOX',
      { page: p.page, pageSize: p.pageSize, filter: p.filter, force: false }),
    'mails.refresh': (p) => mailbox.envelopes(p.accountId, p.folder ?? 'INBOX',
      { force: true, filter: p.filter }),
    'mails.get': (p) => mailbox.read(p.accountId, p.folder, p.uid),
    'attachments.get': (p) => mailbox.attachment(p.accountId, p.folder, p.uid, p.partId),
    'drafts.save': async (p) => {
      const account = await accountStore.get(p.accountId);
      if (!account) throw new Error(`账号不存在: ${p.accountId}`);
      return drafts.save({
        accountId: p.accountId, account,
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
    async stop() { await mailbox.closeAll(); },
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
