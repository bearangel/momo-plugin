// tests/email/service-mailbox.test.ts
// folders 探测 / 缓存优先与强制刷新 / 过滤参数 / 正文守门 / 附件上限 / 超时（Review Focus 2/3/5）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createMailbox, CACHE_TTL_MS } from '../../plugins/email/service/lib/mailbox';
import { createEnvelopeCache } from '../../plugins/email/service/lib/envelope-cache';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-mbox-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

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
  const cache = createEnvelopeCache({ dataDir: dir });
  const accountStore = {
    async get(id: string) { return id === 'acc1' ? ACC : null; },
    async getPassword() { return 'pw'; },
  };
  return createMailbox({
    accountStore, cache, imapConnect: async () => conn,
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

  it('单次 service 调用总预算：两段各 40ms > 60ms → 整链超时（minor-1）', async () => {
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const slow = makeImap();
    (slow as unknown as { search: unknown }).search = async () => { await delay(40); return [1]; };
    (slow as unknown as { fetchEnvelopes: unknown }).fetchEnvelopes = async () => { await delay(40); return []; };
    await expect(makeMailbox(slow).envelopes('acc1', 'INBOX', {})).rejects.toThrow('超时');
  });

  it('TTL 常量 5min', () => { expect(CACHE_TTL_MS).toBe(300000); });
});
