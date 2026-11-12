// tests/email/service-index.test.ts
// handle 路由 / 未知方法 / accounts.test 双探测+先测后存 / tlsMode 映射 / drafts.save→send 全链
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { buildService, shouldResetNamespace } from '../../plugins/email/service/index';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-svc-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

// 保真 FakeImapFlow：真实 ImapFlow 未选箱时 search/fetch/fetchOne 静默空返回（Critical-1 根因），
// 假实现必须同样拒绝操作，否则「适配层忘了 getMailboxLock」会被测试假绿放行。
class FakeImapFlow extends EventEmitter {
  opts: unknown;
  selectedFolder: string | null = null;
  openedFolders: string[] = [];
  lastSearch: unknown = null;
  flagsAdded: Array<{ folder: string; uid: string; flags: string[] }> = [];
  namespace: { prefix: string; delimiter: string } = { prefix: '', delimiter: '/' };
  constructor(opts: unknown) { super(); this.opts = opts; }
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
  lastFetchQuery: unknown = null;
  fetchOneQueries: Array<{ flags?: boolean; source?: boolean }> = [];
  flagsAddReturn: boolean | false = true;
  async *fetch(_uids: unknown, query?: unknown) {
    if (!this.selectedFolder) throw new Error('No mailbox selected');
    this.lastFetchQuery = query;
    yield { uid: 1, envelope: { subject: 's', from: [{ address: 'a@b.c' }], to: [{ address: 'm@n.o' }], date: new Date('2026-11-05T00:00:00Z') }, flags: new Set(), bodyStructure: {}, size: 100 };
  }
  async fetchOne(_seq: unknown, query?: { source?: boolean }) {
    if (!this.selectedFolder) throw new Error('No mailbox selected');
    this.fetchOneQueries.push(query ?? {});
    // query.source → 拉源；否则按单封信封查询返回全字段（仿真真实 ImapFlow fetchOne 两种用法）
    if (query && query.source) return { source: Buffer.from('MIME'), uid: 1 };
    return {
      uid: 1, source: Buffer.from('MIME'),
      envelope: { subject: 's', from: [{ address: 'a@b.c' }], to: [{ address: 'm@n.o' }], date: new Date('2026-11-05T00:00:00Z') },
      flags: new Set(), bodyStructure: {}, size: 100,
    };
  }
  async messageFlagsAdd(uid: string, flags: string[]) {
    if (!this.selectedFolder) throw new Error('No mailbox selected');
    this.flagsAdded.push({ folder: this.selectedFolder, uid, flags });
    return this.flagsAddReturn;
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

  it('folders.peek / mails.peek 路由形状（本地优先）', async () => {
    const svc = buildService(makeDeps());
    await svc.handle('accounts.add', ACC_INPUT);
    const accId = (await svc.handle('accounts.list', {}))[0].id;
    expect(await svc.handle('folders.peek', { accountId: accId })).toEqual({ value: null, savedAt: null });
    const cold = await svc.handle('mails.peek', { accountId: accId, folder: 'INBOX', page: 1, pageSize: 10 }) as Record<string, unknown>;
    expect(cold).toMatchObject({ items: [], total: 0, page: 1, pageSize: 10, savedAt: null });

    await svc.handle('folders.list', { accountId: accId });
    const fp = await svc.handle('folders.peek', { accountId: accId }) as { value: { drafts: string }, savedAt: number };
    expect(fp.value.drafts).toBe('Drafts');
    expect(fp.savedAt).toBeGreaterThan(0);

    await svc.handle('mails.refresh', { accountId: accId, folder: 'INBOX', page: 1, pageSize: 10 });
    const mp = await svc.handle('mails.peek', { accountId: accId, folder: 'INBOX', page: 1, pageSize: 10 }) as { items: Array<{ subject: string }>, savedAt: number };
    expect(mp.items[0]!.subject).toBe('s');
    expect(mp.savedAt).toBeGreaterThan(0);
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

  it('mails.get 读信成功 → messageFlagsAdd(\\Seen)（PEEK 不置已读的兜底回归锁）', async () => {
    let fake: FakeImapFlow | null = null;
    class Spy extends FakeImapFlow { constructor(o: unknown) { super(o); fake = this; } }
    const svc = buildService(makeDeps({ imapflow: Spy }));
    const acc = await svc.handle('accounts.add', ACC_INPUT);
    const r = await svc.handle('mails.get', { accountId: acc.id, folder: 'INBOX', uid: 1 });
    expect(r).toMatchObject({ uid: 1 });
    await new Promise((res) => setTimeout(res, 30));
    expect(fake!.flagsAdded).toContainEqual({ folder: 'INBOX', uid: '1', flags: ['\\Seen'] });
  });

  it('mails.get 透传 patient（面板大邮件慢链路预算）', async () => {
    const svc = buildService(makeDeps());
    const acc = await svc.handle('accounts.add', ACC_INPUT);
    const r = await svc.handle('mails.get', { accountId: acc.id, folder: 'INBOX', uid: 1, patient: true });
    expect(r).toMatchObject({ uid: 1 });
  });

  it('fetch 信封请求必须含 FLAGS 字段（seen 解析契约——2026-11-11 e2e QQ 实测根因回归锁）', async () => {
    let fake: FakeImapFlow | null = null;
    class Spy extends FakeImapFlow { constructor(o: unknown) { super(o); fake = this; } }
    const svc = buildService(makeDeps({ imapflow: Spy }));
    const acc = await svc.handle('accounts.add', ACC_INPUT);
    await svc.handle('mails.refresh', { accountId: acc.id, folder: 'INBOX', page: 1, pageSize: 20 });
    expect((fake!.lastFetchQuery as { flags?: boolean }).flags).toBe(true);
    await svc.handle('mails.get', { accountId: acc.id, folder: 'INBOX', uid: 1 });
    expect(fake!.fetchOneQueries.some((q) => q.flags === true)).toBe(true); // 信封查询（非 source 查询）须带 flags
    await svc.stop();
  });

  it('messageFlagsAdd 静默 false → 不误标本地缓存 seen（adapter 判 false 抛错回归锁）', async () => {
    let fake: FakeImapFlow | null = null;
    class FalseStore extends FakeImapFlow {
      constructor(o: unknown) { super(o); fake = this; this.flagsAddReturn = false as unknown as boolean; }
    }
    const svc = buildService(makeDeps({ imapflow: FalseStore }));
    const acc = await svc.handle('accounts.add', ACC_INPUT);
    await svc.handle('mails.refresh', { accountId: acc.id, folder: 'INBOX', page: 1, pageSize: 20 });
    await svc.handle('mails.get', { accountId: acc.id, folder: 'INBOX', uid: 1 });
    await new Promise((r) => setTimeout(r, 30));
    expect(fake!.flagsAdded.length).toBeGreaterThan(0); // STORE 尝试发生了
    const peek = await svc.handle('mails.peek', { accountId: acc.id, folder: 'INBOX', page: 1, pageSize: 20 }) as { items: Array<{ uid: number; seen: boolean }> };
    expect(peek.items.find((e) => e.uid === 1)!.seen).toBe(false); // 但静默失败不得回写 seen=true
    await svc.stop();
  });

  it('messageFlagsAdd true → markSeen 后本地缓存 seen 回写为 true（全链正例）', async () => {
    const svc = buildService(makeDeps());
    const acc = await svc.handle('accounts.add', ACC_INPUT);
    await svc.handle('mails.refresh', { accountId: acc.id, folder: 'INBOX', page: 1, pageSize: 20 });
    await svc.handle('mails.get', { accountId: acc.id, folder: 'INBOX', uid: 1 });
    await new Promise((r) => setTimeout(r, 30));
    const peek = await svc.handle('mails.peek', { accountId: acc.id, folder: 'INBOX', page: 1, pageSize: 20 }) as { items: Array<{ uid: number; seen: boolean }> };
    expect(peek.items.find((e) => e.uid === 1)!.seen).toBe(true);
    await svc.stop();
  });

  it('mails.get 透传 warmup：>20MB 未归档 → 路由级返回 deferred 形状；不传 warmup 则同步', async () => {
    class BigMail extends FakeImapFlow {
      override async fetchOne(_seq: unknown, query?: { source?: boolean }) {
        if (!this.selectedFolder) throw new Error('No mailbox selected');
        if (query && query.source) return { source: Buffer.from('MIME'), uid: 1 };
        return {
          uid: 1, source: Buffer.from('MIME'),
          envelope: { subject: 'big', from: [{ address: 'a@b.c' }], to: [{ address: 'm@n.o' }], date: new Date('2026-11-05T00:00:00Z') },
          flags: new Set(), bodyStructure: {}, size: 21 * 1024 * 1024,
        };
      }
    }
    const svc = buildService(makeDeps({ imapflow: BigMail }));
    const acc = await svc.handle('accounts.add', ACC_INPUT);
    const d = await svc.handle('mails.get', { accountId: acc.id, folder: 'INBOX', uid: 1, warmup: true }) as { deferred?: boolean; sizeBytes?: number };
    expect(d.deferred).toBe(true);
    expect(d.sizeBytes).toBe(21 * 1024 * 1024);
    const sync = await svc.handle('mails.get', { accountId: acc.id, folder: 'INBOX', uid: 1 }) as { deferred?: boolean };
    expect(sync.deferred).toBeUndefined(); // 面板语义不受影响
    await svc.stop();
  });

  it('attachments.get：临时文件中转契约（tmpPath + bytes，无 base64 面）', async () => {
    const svc = buildService(makeDeps({
      mailparserLib: { simpleParser: async () => ({ text: 't', html: null, attachments: [{ partId: '1.1', filename: 'a.pdf', contentType: 'application/pdf', content: Buffer.from('pdf-bytes') }] }) },
    }));
    const acc = await svc.handle('accounts.add', ACC_INPUT);
    const r = await svc.handle('attachments.get', { accountId: acc.id, folder: 'INBOX', uid: 1, partId: '1.1' }) as { tmpPath: string; filename: string; bytes: number };
    expect(r.filename).toBe('a.pdf');
    expect(r.bytes).toBe('pdf-bytes'.length);
    expect(typeof r.tmpPath).toBe('string');
    expect(r.tmpPath.startsWith(path.join(dir, 'tmp-relay'))).toBe(true);
    expect(fs.readFileSync(r.tmpPath).toString()).toBe('pdf-bytes');
    expect(r).not.toHaveProperty('base64');
    fs.rmSync(r.tmpPath, { force: true });
    await svc.stop();
  });

  it('attachments.get：partId 不存在 → 中文报错', async () => {
    const svc = buildService(makeDeps());
    const acc = await svc.handle('accounts.add', ACC_INPUT);
    await expect(svc.handle('attachments.get', { accountId: acc.id, folder: 'INBOX', uid: 1, partId: '9.9' }))
      .rejects.toThrow('附件不存在');
    await svc.stop();
  });

  it('start 清扫 tmp-relay 过期孤儿（>1h），新文件保留', async () => {
    const stale = path.join(dir, 'tmp-relay', 'stale.bin');
    const fresh = path.join(dir, 'tmp-relay', 'fresh.bin');
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, 'x');
    fs.writeFileSync(fresh, 'x');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    const svc = buildService(makeDeps());
    await svc.start();
    await svc.stop();
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
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

describe('archive 路由与生命周期（2026-11-05 归档 spec §7/§9/§10.1）', () => {
  const ACC_INPUT = {
    email: 'me@qq.com', displayName: null, username: 'me@qq.com', password: 'pw', retention: 'forever',
    imap: { host: 'imap.qq.com', port: 993, tlsMode: 'tls' },
    smtp: { host: 'smtp.qq.com', port: 465, tlsMode: 'tls' },
  };

  it('setRoot/getSettings/clear 路由', async () => {
    const svc = buildService(makeDeps());
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-svc-'));
    const r = await svc.handle('archive.setRoot', { path: root });
    expect(r.rootPath).toBe(fs.realpathSync(root));
    const st = await svc.handle('archive.getSettings', {});
    expect(st.enabled).toBe(true);
    expect(st.rootPath).toBe(fs.realpathSync(root));
    expect(st.files).toBe(0);
    const c = await svc.handle('archive.clear', {});
    expect(c.removed).toBe(0);
    await svc.stop();
  });

  it('setRoot 相对路径 → 中文错误', async () => {
    const svc = buildService(makeDeps());
    await expect(svc.handle('archive.setRoot', { path: 'rel/x' })).rejects.toThrow(/绝对路径/);
    await svc.stop();
  });

  it('读信落盘 → 删除账号级联清理（文件 + 索引）', async () => {
    const svc = buildService(makeDeps());
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-svc-'));
    await svc.handle('archive.setRoot', { path: root });
    const acc = await svc.handle('accounts.add', ACC_INPUT);
    await svc.handle('mails.get', { accountId: acc.id, folder: 'INBOX', uid: 1 });
    await new Promise((r2) => setTimeout(r2, 60));
    const mid = await svc.handle('archive.getSettings', {});
    expect(mid.files).toBe(1);
    const accDir = fs.readdirSync(root).filter((n) => n.startsWith('acc_'));
    expect(accDir).toHaveLength(1);
    await svc.handle('accounts.delete', { id: acc.id });
    const after = await svc.handle('archive.getSettings', {});
    expect(after.files).toBe(0);
    expect(fs.existsSync(path.join(root, accDir[0]!))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
    await svc.stop();
  });

  it('retention 收紧（accounts.update）→ 过期归档被清理', async () => {
    class OldMail extends FakeImapFlow {
      override async *fetch() {
        if (!this.selectedFolder) throw new Error('No mailbox selected');
        yield { uid: 1, envelope: { subject: 'old', from: [{ address: 'a@b.c' }], to: [{ address: 'm@n.o' }], date: new Date('2026-09-01T00:00:00Z') }, flags: new Set(), bodyStructure: {}, size: 100 };
      }
      // 在线读信走 fetchOne 单封信封（2026-11-11 起）：归档行 msg_date 取自此，须同样给旧日期
      override async fetchOne() {
        if (!this.selectedFolder) throw new Error('No mailbox selected');
        return { uid: 1, source: Buffer.from('MIME'), envelope: { subject: 'old', from: [{ address: 'a@b.c' }], to: [{ address: 'm@n.o' }], date: new Date('2026-09-01T00:00:00Z') }, flags: new Set(), bodyStructure: {}, size: 100 };
      }
    }
    const svc = buildService(makeDeps({ imapflow: OldMail }));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-svc-'));
    await svc.handle('archive.setRoot', { path: root });
    const acc = await svc.handle('accounts.add', ACC_INPUT);
    await svc.handle('mails.get', { accountId: acc.id, folder: 'INBOX', uid: 1 });
    await svc.handle('mails.get', { accountId: acc.id, folder: 'Sent', uid: 1 });
    await new Promise((r2) => setTimeout(r2, 60));
    expect((await svc.handle('archive.getSettings', {})).files).toBe(2);
    await svc.handle('accounts.update', { id: acc.id, patch: { retention: '1m' } });
    await new Promise((r2) => setTimeout(r2, 150));
    const after = await svc.handle('archive.getSettings', {});
    expect(after.files).toBe(1);
    expect(after.corrupt + after.missing).toBe(0);
    fs.rmSync(root, { recursive: true, force: true });
    await svc.stop();
  });

  it('start/stop 幂等（无 root 时安全空转）', async () => {
    const svc = buildService(makeDeps());
    await svc.start();
    await svc.stop();
    await svc.stop();
  });
});

describe('archiveRoot 配置对账 + config.get（2026-11-05 配置迁移）', () => {
  it('deps.archiveRoot 指向新目录 → start 自动 setRoot；重复 start 不换 rootId', async () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-cfg-a-'));
    const deps = makeDeps();
    const svc = buildService({ ...deps, archiveRoot: rootA });
    await svc.start();
    const s1 = await svc.handle('archive.getSettings', {});
    expect(s1.enabled).toBe(true);
    expect(s1.rootPath).toBe(fs.realpathSync(rootA));
    await svc.stop();
    const svc2 = buildService({ ...deps, archiveRoot: rootA });
    await svc2.start();
    const s2 = await svc2.handle('archive.getSettings', {});
    expect(s2.rootId).toBe(s1.rootId);
    await svc2.stop();
    fs.rmSync(rootA, { recursive: true, force: true });
  });

  it('archiveRoot 不存在且不允许创建 → warn 降级（服务正常、归档未启用）', async () => {
    const warns: string[] = [];
    const svc = buildService(makeDeps({ logger: { info() {}, warn: (m: string) => warns.push(m), error() {} } }));
    const svc2 = buildService({
      ...makeDeps({ logger: { info() {}, warn: (m: string) => warns.push(m), error() {} } }),
      archiveRoot: path.join(os.tmpdir(), `nope-${Date.now()}`),
    });
    void svc;
    await svc2.start();
    expect(warns.join('\n')).toMatch(/归档|目录/);
    const st = await svc2.handle('archive.getSettings', {});
    expect(st.enabled).toBe(false);
    await svc2.stop();
  });

  it('archiveRootCreate=true（默认目录语义）→ 不存在则自动创建并启用', async () => {
    const root = path.join(os.tmpdir(), `arc-default-${Date.now()}`);
    const svc = buildService({ ...makeDeps(), archiveRoot: root, archiveRootCreate: true });
    await svc.start();
    const st = await svc.handle('archive.getSettings', {});
    expect(st.enabled).toBe(true);
    expect(st.rootPath).toBe(fs.realpathSync(root));
    await svc.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('config.get 路由：showRemoteImages 布尔 + archiveRoot 透传', async () => {
    const svc = buildService({ ...makeDeps(), config: () => ({ showRemoteImages: true, archiveRoot: '/tmp/x' }) });
    const cfg = await svc.handle('config.get', {});
    expect(cfg).toEqual({ showRemoteImages: true, archiveRoot: '/tmp/x' });
    await svc.stop();
  });

  it('effectiveArchiveRoot：空配置 → ~/.momo-plugin/email；禁用开关 → null；显式配置优先', async () => {
    const { effectiveArchiveRoot } = await import('../../plugins/email/service/index');
    const home = '/home/tester';
    expect(effectiveArchiveRoot({}, { homeDir: home })).toBe('/home/tester/.momo-plugin/email');
    expect(effectiveArchiveRoot({ archiveRoot: '/data/mail' }, { homeDir: home })).toBe('/data/mail');
    expect(effectiveArchiveRoot({}, { homeDir: home, disableDefault: true })).toBeNull();
  });
});

describe('createService 宿主入口装配（配置迁移布线回归锁）', () => {
  it('空配置 → 默认目录自动创建并启用；显式 archiveRoot 优先；kill-switch 关闭', async () => {
    const mod = (await import('../../plugins/email/service/index')) as {
      createService: (ctx: unknown, overrides?: { homeDir?: string; disableDefault?: boolean }) => {
        start(): Promise<void>; stop(): Promise<void>;
        handle(m: string, p: unknown): Promise<unknown>;
      };
    };
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-host-home-'));
    const mk = (cfg: Record<string, unknown>, over: { homeDir?: string; disableDefault?: boolean } = {}) =>
      mod.createService({
        getDataDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'arc-host-data-')),
        getConfig: () => cfg,
        secrets: { get: async () => null, set: async () => {}, delete: async () => {} },
        logger: { info() {}, warn() {}, error() {} },
      }, { homeDir: home, ...over });
    const svc = mk({});
    await svc.start();
    const st = await svc.handle('archive.getSettings', {});
    expect(st.enabled).toBe(true);
    expect(st.rootPath).toBe(fs.realpathSync(path.join(home, '.momo-plugin', 'email')));
    await svc.stop();

    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-host-b-'));
    const svc2 = mk({ archiveRoot: rootB });
    await svc2.start();
    expect((await svc2.handle('archive.getSettings', {})).rootPath).toBe(fs.realpathSync(rootB));
    await svc2.stop();

    const svc3 = mk({}, { disableDefault: true });
    await svc3.start();
    expect((await svc3.handle('archive.getSettings', {})).enabled).toBe(false);
    await svc3.stop();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  });
});

describe('IMAP 连接 error 事件兜底（Socket timeout 不再未捕获弹窗）', () => {
  it('client emit error → 不抛未捕获；连接标记不可用并在下次操作重建', async () => {
    const instances: Array<InstanceType<typeof FakeImapFlow>> = [];
    class Flow extends FakeImapFlow {
      constructor(opts: unknown) { super(opts); instances.push(this as never); }
    }
    const svc = buildService(makeDeps({ imapflow: Flow }));
    const acc = await svc.handle('accounts.add', ACC_INPUT);
    await svc.handle('folders.list', { accountId: acc.id });
    expect(instances.length).toBe(1);
    expect(() => instances[0]!.emit('error', Object.assign(new Error('Socket timeout'), { code: 'ETIMEOUT' }))).not.toThrow();
    // 模拟 imapflow 错误后自 close：usable=false → connOf 应丢弃重建
    (instances[0] as unknown as { usable: boolean }).usable = false;
    await svc.handle('mails.list', { accountId: acc.id, folder: 'INBOX', page: 1, pageSize: 5 });
    expect(instances.length).toBe(2);
    await svc.stop();
  });
});
