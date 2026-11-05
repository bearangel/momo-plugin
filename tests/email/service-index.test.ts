// tests/email/service-index.test.ts
// handle 路由 / 未知方法 / accounts.test 双探测 / tlsMode 映射 / drafts.save→send 全链
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { buildService } from '../../plugins/email/service/index';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-svc-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

class FakeImapFlow {
  opts: unknown;
  constructor(opts: unknown) { this.opts = opts; }
  async connect() {}
  async logout() {}
  async list() { return [{ path: 'INBOX', specialUse: '\\Inbox' }, { path: 'Drafts', specialUse: '\\Drafts' }, { path: 'Sent', specialUse: '\\Sent' }]; }
  async search() { return [1]; }
  async *fetch() {
    yield { uid: 1, envelope: { subject: 's', from: [{ address: 'a@b.c' }], to: [{ address: 'm@n.o' }], date: new Date('2026-11-05T00:00:00Z') }, flags: new Set(), bodyStructure: {}, size: 100 };
  }
  async fetchOne() { return { source: Buffer.from('MIME') }; }
  async append() { return { uid: 7 }; }
  async messageDelete() {}
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

  it('未知方法 → 中文错误（fail loud）', async () => {
    const svc = buildService(makeDeps());
    await expect(svc.handle('nope.nothing', {})).rejects.toThrow('未知方法');
  });

  it('accounts.test：IMAP login + SMTP verify 双探测通过', async () => {
    const svc = buildService(makeDeps());
    await svc.handle('accounts.add', ACC_INPUT);
    expect(await svc.handle('accounts.test', { email: 'a@qq.com' })).toEqual({ ok: true });
  });

  it('tlsMode=tls → ImapFlow secure:true（starttls → requireTLS，明文不可能构造）', async () => {
    let seen: unknown;
    class Spy extends FakeImapFlow { constructor(o: unknown) { super(o); seen = o; } }
    const svc = buildService(makeDeps({ imapflow: Spy }));
    await svc.handle('accounts.add', ACC_INPUT);
    await svc.handle('mails.list', { accountId: (await svc.handle('accounts.list', {}))[0].id, folder: 'INBOX' });
    expect(seen).toMatchObject({ secure: true });
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
