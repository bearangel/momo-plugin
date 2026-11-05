// tests/email/service-drafts.test.ts
// 状态机：save→pending、send 仅 pending、重放/不存在拒绝、24h 过期、SMTP 失败保 pending、25MB 守门（Review Focus 3/4）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createDrafts } from '../../plugins/email/service/lib/drafts';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-drafts-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function makeHarness(over: { smtpSend?: () => Promise<void> } = {}) {
  const appended: Array<{ folder: string; raw: Buffer }> = [];
  const deleted: Array<{ folder: string; uid: number }> = [];
  let sentEnv: unknown = null;
  let sentRaw: Buffer | null = null;
  const mailbox = {
    draftsFolder: async () => 'Drafts',
    sentFolder: async () => 'Sent',
    append: async (_acc: string, folder: string, raw: Buffer) => { appended.push({ folder, raw }); return 100 + appended.length; },
    deleteMessage: async (_acc: string, folder: string, uid: number) => { deleted.push({ folder, uid }); },
  };
  let nowMs = Date.parse('2026-11-05T10:00:00Z');
  const drafts = createDrafts({
    dataDir: dir,
    now: () => new Date(nowMs),
    renderMail: async (i: { subject: string }) => Buffer.from(`RAW:${i.subject}`),
    smtpSend: over.smtpSend ?? (async (_accId: string, raw: Buffer, envelope: unknown) => { sentRaw = raw; sentEnv = envelope; }),
    mailbox,
  });
  return { drafts, appended, deleted, sentEnv: () => sentEnv, sentRaw: () => sentRaw, setNow: (ms: number) => { nowMs = ms; } };
}

const ACCOUNT = { id: 'acc1', email: 'me@qq.com' };
const INPUT = {
  accountId: 'acc1', account: ACCOUNT,
  to: ['x@y.z'], cc: [], subject: '报价', text: '正文内容', attachments: [],
};

describe('drafts state machine', () => {
  it('save → APPEND Drafts + pending；send → SMTP(envelope 收件人=草稿登记) + APPEND Sent + 删草稿 + sent', async () => {
    const h = makeHarness();
    const d = await h.drafts.save(INPUT);
    expect(d.status).toBe('pending');
    expect(h.appended[0]!.folder).toBe('Drafts');
    await h.drafts.send(d.id);
    expect((await h.drafts.get(d.id))!.status).toBe('sent');
    expect(h.appended[1]!.folder).toBe('Sent');
    expect(h.deleted[0]!.folder).toBe('Drafts');
    expect(h.sentRaw()!.toString()).toBe('RAW:报价');
    expect(h.sentEnv()).toMatchObject({ from: 'me@qq.com', to: ['x@y.z'] });
  });

  it('send 拒绝：不存在 / 已 sent（重放拒绝）', async () => {
    const h = makeHarness();
    await expect(h.drafts.send('nope')).rejects.toThrow('不存在');
    const d = await h.drafts.save(INPUT);
    await h.drafts.send(d.id);
    await expect(h.drafts.send(d.id)).rejects.toThrow('不可发送');
  });

  it('SMTP 失败 → 状态保持 pending + lastError（可重试）', async () => {
    const h = makeHarness({ smtpSend: async () => { throw new Error('554 rejected'); } });
    const d = await h.drafts.save(INPUT);
    await expect(h.drafts.send(d.id)).rejects.toThrow('554');
    const rec = await h.drafts.get(d.id);
    expect(rec!.status).toBe('pending');
    expect(rec!.lastError).toContain('554');
  });

  it('24h 过期 sweep → discarded', async () => {
    const h = makeHarness();
    const d = await h.drafts.save(INPUT);
    h.setNow(Date.parse('2026-11-05T10:00:00Z') + 25 * 3600 * 1000);
    await h.drafts.sweep();
    expect((await h.drafts.get(d.id))!.status).toBe('discarded');
  });

  it('附件总量 >25MB 拒绝', async () => {
    const h = makeHarness();
    const big = Buffer.alloc(26 * 1024 * 1024);
    await expect(h.drafts.save({ ...INPUT, attachments: [{ filename: 'big.bin', contentType: 'application/octet-stream', data: big }] }))
      .rejects.toThrow('25MB');
  });

  it('drafts.json 损坏 → list 空表不抛', async () => {
    fs.writeFileSync(path.join(dir, 'drafts.json'), '{broken', 'utf-8');
    const h = makeHarness();
    expect(await h.drafts.list()).toEqual([]);
  });
});
