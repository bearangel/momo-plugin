// tests/email/service-mailbox.test.ts
// folders 探测 / 缓存优先与强制刷新 / 过滤参数 / 正文守门 / 附件上限 / 超时（Review Focus 2/3/5）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createMailbox, findFolders, CACHE_TTL_MS } from '../../plugins/email/service/lib/mailbox';
import { createEnvelopeCache } from '../../plugins/email/service/lib/envelope-cache';
import { createStore } from '../../plugins/email/service/lib/store';

let dir: string;
let stores: Array<{ close(): void }> = [];
let lastCache: ReturnType<typeof createEnvelopeCache>;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-mbox-')); stores = []; });
afterEach(() => {
  for (const st of stores) { try { st.close(); } catch { /* 已关闭 */ } }
  fs.rmSync(dir, { recursive: true, force: true });
});

const ACC = { id: 'acc1', email: 'me@qq.com', imap: { host: 'imap.qq.com', port: 993, tlsMode: 'tls' } };

function makeImap(script: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const conn = {
    calls,
    lastCrit: null as unknown,
    lastSource: null as unknown,
    async list() { calls.push('list'); return script.list ?? [
      { path: 'INBOX', specialUse: '\\Inbox' },
      { path: '草稿箱', specialUse: '\\Drafts' },
      { path: '已发送', specialUse: '\\Sent' },
    ]; },
    async search(_f: string, crit: unknown) { calls.push('search'); conn.lastCrit = crit; return script.uids ?? [3, 2, 1]; },
    // 假数据故意升序：真实 IMAP search 返回 uid 升序，列表层须自行降序（Important-4）。
    async fetchEnvelopes() { calls.push('fetch'); return script.envelopes ?? [
      { uid: 1, subject: 's1', from: 'g@h.i', to: 'me@qq.com', date: '2026-11-04T08:00:00Z', seen: false, hasAttachments: false, size: 800 },
      { uid: 2, subject: 's2', from: 'd@e.f', to: 'me@qq.com', date: '2026-11-05T08:00:00Z', seen: true, hasAttachments: true, size: 900 },
      { uid: 3, subject: 's3', from: 'a@b.c', to: 'me@qq.com', date: '2026-11-05T09:00:00Z', seen: false, hasAttachments: false, size: 1200 },
    ]; },
    async fetchSource(folder: string, uid: number) { calls.push('source'); conn.lastSource = { folder, uid }; return Buffer.from(`SRC:${folder}:${uid}`); },
    async status() { calls.push('status'); return { unseen: 2 }; },
    async append() { calls.push('append'); return 42; },
    async deleteMessage() { calls.push('delete'); },
    async close() { calls.push('close'); },
  };
  return conn;
}

function makeMailbox(conn: ReturnType<typeof makeImap>, over: Record<string, unknown> = {}) {
  const store = createStore({ dataDir: dir });
  stores.push(store);
  const cache = createEnvelopeCache({ store });
  lastCache = cache;
  const account = (over.account as typeof ACC | undefined) ?? ACC;
  const accountStore = {
    async get(id: string) { return id === 'acc1' ? account : null; },
    async getPassword() { return 'pw'; },
  };
  return createMailbox({
    accountStore, cache, store, imapConnect: async () => conn,
    parseMail: async () => ({ text: '正文', html: null, attachments: [{ partId: '1.1', filename: 'a.pdf', contentType: 'application/pdf', content: Buffer.from('pdf') }] }),
    opTimeoutMs: 60,
    ...over,
  } as never);
}

describe('mailbox', () => {
  it('folders：specialUse 探测 + 中文/常用名 fallback + unseen 计数', async () => {
    const mb = makeMailbox(makeImap());
    const f = await mb.folders('acc1');
    expect(f.drafts).toBe('草稿箱');
    expect(f.sent).toBe('已发送');
    expect(f.unseen.INBOX).toBe(2);
    expect(f.unseen['草稿箱']).toBe(2);
    const conn2 = makeImap({ list: [{ path: 'INBOX' }, { path: 'Drafts' }, { path: 'Sent Items' }] });
    const f2 = await makeMailbox(conn2).folders('acc1');
    expect(f2.drafts).toBe('Drafts');
    expect(f2.sent).toBe('Sent Items');
  });

  it('resolveAppendedUid：按 X-Momo-Draft-Id 反查取最大 uid；未命中 0', async () => {
    const conn = makeImap({ uids: [4, 9, 7] });
    await expect(makeMailbox(conn).resolveAppendedUid('acc1', '草稿箱', 'draft_x')).resolves.toBe(9);
    expect(conn.lastCrit).toEqual({ header: { 'X-Momo-Draft-Id': 'draft_x' } });
    const miss = makeImap({ uids: [] });
    await expect(makeMailbox(miss).resolveAppendedUid('acc1', '草稿箱', 'nope')).resolves.toBe(0);
  });

  it('folders：60s 内存缓存 + invalidateFolders 失效', async () => {
    const conn = makeImap();
    const mb = makeMailbox(conn);
    await mb.folders('acc1');
    await mb.folders('acc1');
    expect(conn.calls.filter((c) => c === 'list')).toHaveLength(1);
    mb.invalidateFolders('acc1');
    await mb.folders('acc1');
    expect(conn.calls.filter((c) => c === 'list')).toHaveLength(2);
  });

  it('folders：status 失败 best-effort——不抛、unseen 计 0、候选字段置 null', async () => {
    const conn = makeImap({ list: [
      { path: 'INBOX', specialUse: '\\Inbox' },
      { path: '草稿箱', specialUse: '\\Drafts' },
      { path: '已发送', specialUse: '\\Sent' },
    ] });
    (conn as unknown as { status: unknown }).status = async (folder: string) => {
      if (folder === '已发送') throw new Error("Mailbox doesn't exist: 已发送");
      return { unseen: 2 };
    };
    const f = await makeMailbox(conn).folders('acc1');
    expect(f.sent).toBeNull();
    expect(f.unseen['已发送']).toBe(0);
    expect(f.drafts).toBe('草稿箱');
  });

  it('folders：modified-UTF-7 名称匹配（新浪路径），全候选失败则 sent=null', async () => {
    const path = '&YhF2hJHNiYFlh072-/已发送';
    const ok = makeImap({ list: [{ path: 'INBOX' }, { path }] });
    expect((await makeMailbox(ok).folders('acc1')).sent).toBe(path);
    const broken = makeImap({ list: [{ path: 'INBOX' }, { path }] });
    (broken as unknown as { status: unknown }).status = async (p: string) => {
      throw new Error(`Mailbox doesn't exist: ${p}`);
    };
    expect((await makeMailbox(broken).folders('acc1')).sent).toBeNull();
  });

  it('新浪实景：编码父段路径 + status 只认解码路径 → sent/drafts 用 workingPath', async () => {
    const P = '&YhF2hJHNiYFlh072-';
    const list = [
      { path: 'INBOX', specialUse: '\\Inbox' },
      { path: `${P}/已发送`, specialUse: '\\Sent' },
      { path: `${P}/草稿夹` },
      { path: `${P}/垃圾邮件` },
      { path: `${P}/广告邮件` },
      { path: `${P}/订阅邮件` },
      { path: `${P}/重要邮件` },
      { path: `${P}/其他邮件` },
      { path: `${P}/回收站` },
      { path: `${P}/病毒邮件` },
      { path: `${P}/自定义文件夹` },
    ];
    const conn = makeImap({ list });
    (conn as unknown as { status: unknown }).status = async (p: string) => {
      if (p.includes(P)) throw new Error(`Mailbox doesn't exist: ${p}`);
      return { unseen: 1 };
    };
    const f = await makeMailbox(conn).folders('acc1');
    expect(f.sent).toBe('我的重要文件/已发送');
    expect(f.drafts).toBe('我的重要文件/草稿夹');
    expect(f.unseen['我的重要文件/已发送']).toBe(1);
    expect(f.unseen['我的重要文件/草稿夹']).toBe(1);
    expect(f.all).toHaveLength(11);
  });

  it('新浪实景：全部候选失败 → sent/drafts null 且 folders() 不抛', async () => {
    const P = '&YhF2hJHNiYFlh072-';
    const conn = makeImap({ list: [
      { path: 'INBOX', specialUse: '\\Inbox' },
      { path: `${P}/已发送`, specialUse: '\\Sent' },
      { path: `${P}/草稿夹` },
    ] });
    (conn as unknown as { status: unknown }).status = async (p: string) => {
      throw new Error(`Mailbox doesn't exist: ${p}`);
    };
    const f = await makeMailbox(conn).folders('acc1');
    expect(f.sent).toBeNull();
    expect(f.drafts).toBeNull();
  });

  it('findFolders：specialUse 优先、去重、名称命中补位', () => {
    const raw = [
      { path: 'B/已发送' },
      { path: 'A/已发送', specialUse: '\\Sent' },
      { path: 'A/已发送' },
    ];
    expect(findFolders(raw, '\\Sent', ['已发送'])).toEqual(['A/已发送', 'B/已发送']);
  });

  it('findFolders：末段解码命中（草稿夹）', () => {
    const raw = [{ path: '&YhF2hJHNiYFlh072-/草稿夹' }];
    expect(findFolders(raw, '\\Drafts', ['草稿夹'])).toEqual(['&YhF2hJHNiYFlh072-/草稿夹']);
  });

  it('draftsFolder：识别不到必须抛错，绝不回退 INBOX', async () => {
    const conn = makeImap({ list: [{ path: 'INBOX', specialUse: '\\Inbox' }] });
    await expect(makeMailbox(conn).draftsFolder('acc1')).rejects.toThrow('未能识别');
  });

  it('sentFolder：识别不到返回 null（不回退 INBOX）', async () => {
    const conn = makeImap({ list: [{ path: 'INBOX', specialUse: '\\Inbox' }] });
    await expect(makeMailbox(conn).sentFolder('acc1')).resolves.toBeNull();
  });

  it('retention=1m：旧信封不返回且不落库（本地缓存，不动服务器）', async () => {
    const now = new Date().toISOString();
    const conn = makeImap({ envelopes: [
      { uid: 1, subject: 'old', from: 'a', to: 'b', date: '2020-01-01T00:00:00Z', seen: false, hasAttachments: false, size: 100 },
      { uid: 2, subject: 'new', from: 'a', to: 'b', date: now, seen: false, hasAttachments: false, size: 100 },
    ] });
    const mb = makeMailbox(conn, { account: { ...ACC, retention: '1m' } });
    const page = await mb.envelopes('acc1', 'INBOX', { force: true });
    expect(page.items.map((e) => e.uid)).toEqual([2]);
    expect(lastCache.read('acc1', 'INBOX')!.items.map((e) => e.uid)).toEqual([2]);
  });

  it('retention=1m + sent 文件夹 → 全保留（Sent 永久）', async () => {
    const conn = makeImap({ envelopes: [
      { uid: 1, subject: 'old', from: 'a', to: 'b', date: '2020-01-01T00:00:00Z', seen: false, hasAttachments: false, size: 100 },
      { uid: 2, subject: 'new', from: 'a', to: 'b', date: new Date().toISOString(), seen: false, hasAttachments: false, size: 100 },
    ] });
    const mb = makeMailbox(conn, { account: { ...ACC, retention: '1m' } });
    const page = await mb.envelopes('acc1', '已发送', { force: true });
    expect(page.items.map((e) => e.uid)).toEqual([2, 1]);
  });

  it('retention=1m 但 sent 探测失败 → 不清理（fail-safe）', async () => {
    const conn = makeImap({ envelopes: [
      { uid: 1, subject: 'old', from: 'a', to: 'b', date: '2020-01-01T00:00:00Z', seen: false, hasAttachments: false, size: 100 },
      { uid: 2, subject: 'new', from: 'a', to: 'b', date: new Date().toISOString(), seen: false, hasAttachments: false, size: 100 },
    ] });
    (conn as unknown as { list: unknown }).list = async () => { throw new Error('list boom'); };
    const mb = makeMailbox(conn, { account: { ...ACC, retention: '1m' } });
    const page = await mb.envelopes('acc1', 'INBOX', { force: true });
    expect(page.items.map((e) => e.uid)).toEqual([2, 1]);
  });

  it('retention=forever（缺省）→ 不清理', async () => {
    const conn = makeImap({ envelopes: [
      { uid: 1, subject: 'old', from: 'a', to: 'b', date: '2020-01-01T00:00:00Z', seen: false, hasAttachments: false, size: 100 },
      { uid: 2, subject: 'new', from: 'a', to: 'b', date: new Date().toISOString(), seen: false, hasAttachments: false, size: 100 },
    ] });
    const page = await makeMailbox(conn).envelopes('acc1', 'INBOX', { force: true });
    expect(page.items.map((e) => e.uid)).toEqual([2, 1]);
  });

  it('foldersPeek：内存优先（不触网）', async () => {
    const conn = makeImap();
    const mb = makeMailbox(conn);
    await mb.folders('acc1');
    const before = conn.calls.filter((c) => c === 'list').length;
    const peek = await mb.foldersPeek('acc1');
    expect(peek.value!.drafts).toBe('草稿箱');
    expect(peek.savedAt).toBeGreaterThan(0);
    expect(conn.calls.filter((c) => c === 'list')).toHaveLength(before);
  });

  it('foldersPeek：无内存时读 DB（新实例、不触网）', async () => {
    const mb1 = makeMailbox(makeImap());
    await mb1.folders('acc1');
    const offline = makeImap();
    (offline as unknown as { list: unknown }).list = async () => { throw new Error('should not hit network'); };
    const peek = await makeMailbox(offline).foldersPeek('acc1');
    expect(peek.value!.drafts).toBe('草稿箱');
    expect(offline.calls).toHaveLength(0);
  });

  it('foldersPeek：都无缓存 → null', async () => {
    expect(await makeMailbox(makeImap()).foldersPeek('acc1')).toEqual({ value: null, savedAt: null });
  });

  it('envelopesPeek：忽略 TTL、uid 降序分页、retention 过滤且 Sent 豁免', async () => {
    const now = new Date().toISOString();
    const envs = [
      { uid: 1, subject: 'old', from: 'a', to: 'b', date: '2020-01-01T00:00:00Z', seen: false, hasAttachments: false, size: 100 },
      { uid: 2, subject: 'mid', from: 'a', to: 'b', date: now, seen: false, hasAttachments: false, size: 100 },
      { uid: 3, subject: 'new', from: 'a', to: 'b', date: now, seen: false, hasAttachments: false, size: 100 },
    ];
    const conn = makeImap({ envelopes: envs });
    const mb = makeMailbox(conn, { account: { ...ACC, retention: '1m' } });
    await mb.envelopes('acc1', 'INBOX', { force: true });
    await mb.envelopes('acc1', '已发送', { force: true });
    const peek = await mb.envelopesPeek('acc1', 'INBOX', { page: 1, pageSize: 2 });
    expect(peek.items.map((e) => e.uid)).toEqual([3, 2]);
    expect(peek.total).toBe(2);
    expect(peek.savedAt).toBeGreaterThan(0);
    const sentPeek = await mb.envelopesPeek('acc1', '已发送', { page: 1, pageSize: 10 });
    expect(sentPeek.items.map((e) => e.uid)).toEqual([3, 2, 1]);
  });

  it('connOf：usable()===false 时丢弃重建', async () => {
    const c1 = makeImap();
    let unusable = false;
    (c1 as unknown as { usable: unknown }).usable = () => !unusable;
    const c2 = makeImap();
    let connects = 0;
    const mb = makeMailbox(c1, { imapConnect: async () => { connects += 1; return connects === 1 ? c1 : c2; } });
    await mb.folders('acc1');
    expect(connects).toBe(1);
    unusable = true;
    const page = await mb.envelopes('acc1', 'INBOX', { force: true });
    expect(connects).toBe(2);
    expect(page.items.length).toBe(3);
  });

  it('withConn：连接类错误重试一次成功；业务错误不重试', async () => {
    const conn = makeImap();
    let searches = 0;
    const origSearch = conn.search.bind(conn);
    (conn as unknown as { search: unknown }).search = async (folder: string, crit: unknown) => {
      searches += 1;
      if (searches === 1) throw new Error('Connection not available');
      return origSearch(folder, crit);
    };
    const page = await makeMailbox(conn).envelopes('acc1', 'INBOX', { force: true });
    expect(searches).toBe(2);
    expect(page.items.length).toBe(3);

    const biz = makeImap();
    let calls = 0;
    (biz as unknown as { search: unknown }).search = async () => { calls += 1; throw new Error("Mailbox doesn't exist: X"); };
    await expect(makeMailbox(biz).envelopes('acc1', 'INBOX', { force: true })).rejects.toThrow('Mailbox');
    expect(calls).toBe(1);
  });

  it('envelopes：首次拉 IMAP 落缓存；TTL 内二次不触网；force 强制刷新；uid 降序分页', async () => {
    const conn = makeImap();
    const mb = makeMailbox(conn);
    const page = await mb.envelopes('acc1', 'INBOX', {});
    expect(page.items.map((e) => e.uid)).toEqual([3, 2, 1]);
    await mb.envelopes('acc1', 'INBOX', {});
    expect(conn.calls.filter((c) => c === 'search')).toHaveLength(1);
    await mb.envelopes('acc1', 'INBOX', { force: true });
    expect(conn.calls.filter((c) => c === 'search')).toHaveLength(2);
  });

  it('缓存污染防护：带 filter 直拉不落缓存，紧接无 filter 重新触网', async () => {
    const conn = makeImap();
    const mb = makeMailbox(conn);
    await mb.envelopes('acc1', 'INBOX', { filter: { from: 'a@b.c' } });
    await mb.envelopes('acc1', 'INBOX', {});
    expect(conn.calls.filter((c) => c === 'search')).toHaveLength(2);
  });

  it('filter 透传 search 条件；pageSize 钳制 ≤50', async () => {
    const conn = makeImap();
    const mb = makeMailbox(conn);
    const page = await mb.envelopes('acc1', 'INBOX', {
      filter: { since: '2026-11-05', unreadOnly: true, from: 'a@b.c', subject: '报价' }, pageSize: 999,
    });
    expect(page.items.length).toBeLessThanOrEqual(50);
    expect(conn.lastCrit).toMatchObject({ since: '2026-11-05', unseen: true, from: 'a@b.c', subject: '报价' });
  });

  it('read：>2MB 拒收；text >200KB 截断标注', async () => {
    const conn = makeImap({ envelopes: [{ uid: 1, subject: 's', from: 'a@b.c', to: 'm', date: '2026-11-05T00:00:00Z', seen: false, hasAttachments: true, size: 3 * 1024 * 1024 }] });
    await expect(makeMailbox(conn).read('acc1', 'INBOX', 1)).rejects.toThrow('2MB');
    const mb2 = makeMailbox(makeImap(), { parseMail: async () => ({ text: 'x'.repeat(250 * 1024), html: null, attachments: [] }) });
    const r = await mb2.read('acc1', 'INBOX', 3);
    expect(r.text.length).toBeLessThanOrEqual(200 * 1024 + 40);
    expect(r.truncated).toBe(true);
  });

  it('read：mailparser html=false → 归一为 null（纯文本不误判 HTML）', async () => {
    const mb = makeMailbox(makeImap(), {
      parseMail: async () => ({ text: '纯文本正文', html: false, attachments: [] }),
    });
    const r = await mb.read('acc1', 'INBOX', 3);
    expect(r.html).toBeNull();
    expect(r.text).toBe('纯文本正文');
  });

  it('read：mailparser html="" → 归一为 null', async () => {
    const mb = makeMailbox(makeImap(), {
      parseMail: async () => ({ text: 't', html: '', attachments: [] }),
    });
    expect((await mb.read('acc1', 'INBOX', 3)).html).toBeNull();
  });

  it('read：HTML-only >200KB 同样截断（Important-3）', async () => {
    const mb = makeMailbox(makeImap(), { parseMail: async () => ({ text: '', html: 'h'.repeat(250 * 1024), attachments: [] }) });
    const r = await mb.read('acc1', 'INBOX', 3);
    expect(r.truncated).toBe(true);
    expect(r.html!.length).toBeLessThanOrEqual(200 * 1024 + 40);
  });

  it('read/attachment 传 folder 给 fetchSource（选箱契约）', async () => {
    const conn = makeImap();
    await makeMailbox(conn).read('acc1', 'INBOX', 3);
    expect(conn.lastSource).toEqual({ folder: 'INBOX', uid: 3 });
    const conn2 = makeImap();
    await makeMailbox(conn2).attachment('acc1', 'INBOX', 2, '1.1');
    expect(conn2.lastSource).toEqual({ folder: 'INBOX', uid: 2 });
  });

  it('正文内存 LRU：同参数 read 两次只取一次源', async () => {
    const conn = makeImap();
    const mb = makeMailbox(conn);
    await mb.read('acc1', 'INBOX', 3);
    await mb.read('acc1', 'INBOX', 3);
    expect(conn.calls.filter((c) => c === 'source')).toHaveLength(1);
  });

  it('attachment：≤10MB 守门 + partId 命中返回 base64', async () => {
    const conn = makeImap({ envelopes: [{ uid: 2, subject: 's', from: 'a@b.c', to: 'm', date: '2026-11-05T00:00:00Z', seen: true, hasAttachments: true, size: 11 * 1024 * 1024 }] });
    await expect(makeMailbox(conn).attachment('acc1', 'INBOX', 2, '1.1')).rejects.toThrow('10MB');
    const a = await makeMailbox(makeImap()).attachment('acc1', 'INBOX', 2, '1.1');
    expect(a.filename).toBe('a.pdf');
    expect(a.base64).toBe(Buffer.from('pdf').toString('base64'));
  });

  it('单操作超时 → 中文错误', async () => {
    const hang = makeImap();
    (hang as unknown as { search: unknown }).search = () => new Promise(() => undefined);
    await expect(makeMailbox(hang).envelopes('acc1', 'INBOX', {})).rejects.toThrow('超时');
  });

  it('folders 整链总预算：list 40ms + status 并行 30ms > 60ms → 整链超时（残留 1）', async () => {
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const slow = makeImap();
    (slow as unknown as { list: unknown }).list = async () => {
      await delay(40);
      return [{ path: 'INBOX' }, { path: 'Drafts' }, { path: 'Sent' }];
    };
    (slow as unknown as { status: unknown }).status = async () => { await delay(30); return { unseen: 0 }; };
    await expect(makeMailbox(slow).folders('acc1')).rejects.toThrow('超时');
  });

  it('单次 service 调用总预算：两段各 40ms > 60ms → 整链超时（minor-1）', async () => {
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const slow = makeImap();
    (slow as unknown as { search: unknown }).search = async () => { await delay(40); return [1]; };
    (slow as unknown as { fetchEnvelopes: unknown }).fetchEnvelopes = async () => { await delay(40); return []; };
    await expect(makeMailbox(slow).envelopes('acc1', 'INBOX', {})).rejects.toThrow('超时');
  });

  it('TTL 常量 5min', () => { expect(CACHE_TTL_MS).toBe(300000); });
});
