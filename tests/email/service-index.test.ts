// tests/email/service-index.test.ts
// handle 路由 / 未知方法 / accounts.test 双探测+先测后存 / tlsMode 映射 / drafts.save→send 全链
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { buildService, shouldResetNamespace } from '../../plugins/email/service/index';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-svc-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

// 保真 FakeImapFlow：真实 ImapFlow 未选箱时 search/fetch/fetchOne 静默空返回（Critical-1 根因），
// 假实现必须同样拒绝操作，否则「适配层忘了 getMailboxLock」会被测试假绿放行。
class FakeImapFlow {
  opts: unknown;
  selectedFolder: string | null = null;
  openedFolders: string[] = [];
  lastSearch: unknown = null;
  namespace: { prefix: string; delimiter: string } = { prefix: '', delimiter: '/' };
  constructor(opts: unknown) { this.opts = opts; }
  async connect() {}
  async logout() {}
  async list() {
    const base = [{ path: 'INBOX', specialUse: '\\Inbox' }, { path: 'Drafts', specialUse: '\\Drafts' }, { path: 'Sent', specialUse: '\\Sent' }];
    const prefix = this.namespace.prefix;
    return prefix ? base.map((f) => ({ ...f, path: f.path === 'INBOX' ? 'INBOX' : prefix + f.path })) : base;
  }
  async getMailboxLock(folder: string) {
    this.selectedFolder = folder;
    this.openedFolders.push(folder);
    return { release: () => {} };
  }
  async search(crit?: unknown) {
    if (!this.selectedFolder) throw new Error('No mailbox selected');
    this.lastSearch = crit;
    return [1];
  }
  async *fetch() {
    if (!this.selectedFolder) throw new Error('No mailbox selected');
    yield { uid: 1, envelope: { subject: 's', from: [{ address: 'a@b.c' }], to: [{ address: 'm@n.o' }], date: new Date('2026-11-05T00:00:00Z') }, flags: new Set(), bodyStructure: {}, size: 100 };
  }
  async fetchOne() {
    if (!this.selectedFolder) throw new Error('No mailbox selected');
    return { source: Buffer.from('MIME') };
  }
  async status() { return { unseen: 2 }; }
  async append() { return { uid: 7 }; }
  async messageDelete() {
    if (!this.selectedFolder) throw new Error('No mailbox selected');
  }
  async close() {}
}
function makeDeps(over: Record<string, unknown> = {}) {
  return {
    dataDir: dir,
    secrets: { get: async () => null, set: async () => {}, delete: async () => {} },
    logger: { info() {}, warn() {}, error() {} },
    imapflow: FakeImapFlow,
    nodemailerLib: { createTransport: () => ({ verify: async () => true, sendMail: async () => ({ ok: true }) }) },
    mailparserLib: { simpleParser: async () => ({ text: 't', html: null, attachments: [] }) },
    ...over,
  } as never;
}

const ACC_INPUT = {
  email: 'a@qq.com', username: 'a@qq.com', password: 'pw',
  imap: { host: 'imap.qq.com', port: 993, tlsMode: 'tls' },
  smtp: { host: 'smtp.qq.com', port: 465, tlsMode: 'tls' },
};

describe('service index', () => {
  it('shouldResetNamespace：仅含 & 的伪前缀才重置', () => {
    expect(shouldResetNamespace('&YhF2hJHNiYFlh072-/')).toBe(true);
    expect(shouldResetNamespace('INBOX.')).toBe(false);
    expect(shouldResetNamespace('')).toBe(false);
  });

  it('新浪伪 NAMESPACE：connect 后覆写 prefix=""，list/lock 用干净文件夹名', async () => {
    let fake: FakeImapFlow | null = null;
    class Sina extends FakeImapFlow {
      constructor(o: unknown) {
        super(o);
        fake = this;
        this.namespace = { prefix: '&YhF2hJHNiYFlh072-/', delimiter: '/' };
      }
    }
    const svc = buildService(makeDeps({ imapflow: Sina }));
    await svc.handle('accounts.add', ACC_INPUT);
    const accId = (await svc.handle('accounts.list', {}))[0].id;
    const f = await svc.handle('folders.list', { accountId: accId }) as { drafts: string };
    expect(fake!.namespace.prefix).toBe('');
    expect(f.drafts).toBe('Drafts');
    await svc.handle('mails.list', { accountId: accId, folder: 'Drafts' });
    expect(fake!.openedFolders).toContain('Drafts');
  });

  it('正常 NAMESPACE 前缀（INBOX.）不得覆写', async () => {
    let fake: FakeImapFlow | null = null;
    class Normal extends FakeImapFlow {
      constructor(o: unknown) {
        super(o);
        fake = this;
        this.namespace = { prefix: 'INBOX.', delimiter: '.' };
      }
    }
    const svc = buildService(makeDeps({ imapflow: Normal }));
    await svc.handle('accounts.add', ACC_INPUT);
    await svc.handle('folders.list', { accountId: (await svc.handle('accounts.list', {}))[0].id });
    expect(fake!.namespace).toEqual({ prefix: 'INBOX.', delimiter: '.' });
  });

  it('accounts.add→list→folders.list→mails.list 全链（fake vendor）', async () => {
    const svc = buildService(makeDeps());
    await svc.start();
    await svc.handle('accounts.add', ACC_INPUT);
    const accounts = await svc.handle('accounts.list', {});
    expect(accounts).toHaveLength(1);
    const f = await svc.handle('folders.list', { accountId: accounts[0].id });
    expect(f.drafts).toBe('Drafts');
    const page = await svc.handle('mails.list', { accountId: accounts[0].id, folder: 'INBOX' });
    expect(page.items[0].subject).toBe('s');
    await svc.stop();
  });

  it('mails.list 前必须选箱：openedFolders 含 INBOX（Critical-1 回归锁）', async () => {
    let fake: FakeImapFlow | null = null;
    class Spy extends FakeImapFlow { constructor(o: unknown) { super(o); fake = this; } }
    const svc = buildService(makeDeps({ imapflow: Spy }));
    await svc.handle('accounts.add', ACC_INPUT);
    const accId = (await svc.handle('accounts.list', {}))[0].id;
    await svc.handle('mails.list', { accountId: accId, folder: 'INBOX' });
    expect(fake!.openedFolders).toContain('INBOX');
  });

  it('FakeImapFlow 保真：未选箱直接 search/fetchOne 必须抛（建模真实 ImapFlow 语义）', async () => {
    const fake = new FakeImapFlow({});
    await expect(fake.search()).rejects.toThrow('No mailbox selected');
    await expect(fake.fetchOne()).rejects.toThrow('No mailbox selected');
    await fake.getMailboxLock('INBOX');
    await expect(fake.search()).resolves.toEqual([1]);
  });

  it('未知方法 → 中文错误（fail loud）', async () => {
    const svc = buildService(makeDeps());
    await expect(svc.handle('nope.nothing', {})).rejects.toThrow('未知方法');
  });

  it('accounts.test：IMAP login + SMTP verify 双探测通过', async () => {
    const svc = buildService(makeDeps());
    await svc.handle('accounts.add', ACC_INPUT);
    expect(await svc.handle('accounts.test', { email: 'a@qq.com' })).toEqual({ ok: true });
  });

  it('accounts.test 先测后存：表单直测（带 imap/smtp/password）回 ok 且不落库不写凭据', async () => {
    let secretWrites = 0;
    const svc = buildService(makeDeps({
      secrets: { get: async () => null, set: async () => { secretWrites += 1; }, delete: async () => {} },
    }));
    const r = await svc.handle('accounts.test', { ...ACC_INPUT, email: 'probe@qq.com' });
    expect(r).toEqual({ ok: true });
    expect(await svc.handle('accounts.list', {})).toHaveLength(0);
    expect(secretWrites).toBe(0);
  });

  it('accounts.test SMTP verify 挂起 → 超时文案（smtpTimeoutMs 上限）', async () => {
    const svc = buildService(makeDeps({
      smtpTimeoutMs: 20,
      nodemailerLib: { createTransport: () => ({ verify: () => new Promise(() => undefined), sendMail: async () => ({ ok: true }) }) },
    }));
    const r = await svc.handle('accounts.test', { ...ACC_INPUT, email: 'slow@qq.com' }) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain('超时');
  });

  it('accounts.test：编辑态传密码走传入值，留空走已存值', async () => {
    const imapPasses: unknown[] = [];
    const smtpPasses: unknown[] = [];
    class Spy extends FakeImapFlow {
      constructor(o: unknown) { super(o); imapPasses.push((o as { auth?: { pass?: unknown } }).auth?.pass); }
    }
    const smtpLib = {
      createTransport: (o: { auth?: { pass?: unknown } }) => {
        smtpPasses.push(o.auth?.pass);
        return { verify: async () => true, sendMail: async () => ({ ok: true }) };
      },
    };
    const m = new Map<string, string>();
    const secrets = {
      async get(k: string) { return m.get(k) ?? null; },
      async set(k: string, v: string) { m.set(k, v); },
      async delete(k: string) { m.delete(k); },
    };
    const svc = buildService(makeDeps({ imapflow: Spy, nodemailerLib: smtpLib, secrets }));
    await svc.handle('accounts.add', ACC_INPUT);
    expect(await svc.handle('accounts.test', { email: 'a@qq.com', password: 'new-pw' })).toEqual({ ok: true });
    expect(imapPasses[0]).toBe('new-pw');
    expect(smtpPasses[0]).toBe('new-pw');
    expect(await svc.handle('accounts.test', { email: 'a@qq.com', password: '' })).toEqual({ ok: true });
    expect(imapPasses[1]).toBe('pw');
    expect(smtpPasses[1]).toBe('pw');
  });

  it('tlsMode=tls → ImapFlow secure:true（starttls → requireTLS，明文不可能构造）', async () => {
    let seen: unknown;
    class Spy extends FakeImapFlow { constructor(o: unknown) { super(o); seen = o; } }
    const svc = buildService(makeDeps({ imapflow: Spy }));
    await svc.handle('accounts.add', ACC_INPUT);
    await svc.handle('mails.list', { accountId: (await svc.handle('accounts.list', {}))[0].id, folder: 'INBOX' });
    expect(seen).toMatchObject({ secure: true });
  });

  it('认证失败 → 账号健康态标 error（AUTHENTICATIONFAILED）', async () => {
    class AuthFail extends FakeImapFlow {
      async connect() { throw new Error('AUTHENTICATIONFAILED Invalid credentials'); }
    }
    const svc = buildService(makeDeps({ imapflow: AuthFail }));
    await svc.handle('accounts.add', ACC_INPUT);
    const accId = (await svc.handle('accounts.list', {}))[0].id;
    await expect(svc.handle('mails.list', { accountId: accId, folder: 'INBOX' }))
      .rejects.toThrow('AUTHENTICATIONFAILED');
    const after = (await svc.handle('accounts.list', {})) as Array<{ health: { state: string } }>;
    expect(after[0]!.health.state).toBe('error');
  });

  it('adapter search 透传 header 条件（APPEND 无 uid 时按 X-Momo-Draft-Id 反查）', async () => {
    let fake: FakeImapFlow | null = null;
    class NoUid extends FakeImapFlow {
      constructor(o: unknown) {
        super(o);
        fake = this;
        (this as unknown as { append: unknown }).append = async () => ({ destination: 'Drafts', path: 'Drafts' });
      }
    }
    const svc = buildService(makeDeps({ imapflow: NoUid }));
    await svc.handle('accounts.add', ACC_INPUT);
    const accId = (await svc.handle('accounts.list', {}))[0].id;
    const d = await svc.handle('drafts.save', { accountId: accId, to: 'x@y.z', subject: 'S', text: 'T' });
    expect(fake!.lastSearch).toEqual({ header: { 'X-Momo-Draft-Id': d.id } });
  });

  it('drafts.save（base64 附件）→ drafts.send 状态机全链', async () => {
    const svc = buildService(makeDeps());
    await svc.handle('accounts.add', ACC_INPUT);
    const accId = (await svc.handle('accounts.list', {}))[0].id;
    const d = await svc.handle('drafts.save', {
      accountId: accId, to: 'x@y.z', subject: 'S', text: 'T',
      attachments: [{ filename: 'a.bin', contentType: 'application/octet-stream', base64: Buffer.from('bin').toString('base64') }],
    });
    expect(d.status).toBe('pending');
    const sent = await svc.handle('drafts.send', { draftId: d.id });
    expect(sent.status).toBe('sent');
  });

  it('drafts.save __first__ 哨兵：无账号拒绝，有账号回退首账号', async () => {
    const svc = buildService(makeDeps());
    await expect(svc.handle('drafts.save', { accountId: '__first__', to: 'x@y.z', subject: 'S', text: 'T' }))
      .rejects.toThrow('尚未配置邮箱账号');
    await svc.handle('accounts.add', ACC_INPUT);
    const firstId = (await svc.handle('accounts.list', {}))[0].id;
    const d = await svc.handle('drafts.save', { accountId: '__first__', to: 'x@y.z', subject: 'S', text: 'T' });
    expect(d.status).toBe('pending');
    expect((await svc.handle('drafts.list', {}))[0].accountId).toBe(firstId);
  });
});
