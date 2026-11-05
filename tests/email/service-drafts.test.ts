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

function makeHarness(over: { smtpSend?: (accId: string, raw: Buffer, envelope: unknown) => Promise<void> } = {}) {
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

  it('discard pending → deleteMessage 被调 + 状态 discarded', async () => {
    const h = makeHarness();
    const d = await h.drafts.save(INPUT);
    await h.drafts.discard(d.id);
    expect(h.deleted).toHaveLength(1);
    expect(h.deleted[0]).toMatchObject({ folder: 'Drafts', uid: d.uid });
    expect((await h.drafts.get(d.id))!.status).toBe('discarded');
  });

  it('discard sent 记录 → no-op（状态仍 sent、deleted 无新增）', async () => {
    const h = makeHarness();
    const d = await h.drafts.save(INPUT);
    await h.drafts.send(d.id);
    const delCount = h.deleted.length;
    await h.drafts.discard(d.id);
    expect(h.deleted).toHaveLength(delCount);
    expect((await h.drafts.get(d.id))!.status).toBe('sent');
  });

  it('send 过期草稿（不经 list）→ 拒绝「已过期作废」且状态变 discarded', async () => {
    const h = makeHarness();
    const d = await h.drafts.save(INPUT);
    h.setNow(Date.parse('2026-11-05T10:00:00Z') + 25 * 3600 * 1000);
    await expect(h.drafts.send(d.id)).rejects.toThrow('已过期作废');
    const rec = await h.drafts.get(d.id);
    expect(rec!.status).toBe('discarded');
    expect(rec!.expireReason).toBe('24h 未确认自动作废');
  });

  it('SMTP 失败后重试成功 → 最终 sent + envelope 透传自登记条目', async () => {
    let fail = true;
    let env: unknown = null;
    const h = makeHarness({ smtpSend: async (_acc, _raw, envelope) => {
      if (fail) throw new Error('554 rejected');
      env = envelope;
    } });
    const d = await h.drafts.save(INPUT);
    await expect(h.drafts.send(d.id)).rejects.toThrow('554');
    expect((await h.drafts.get(d.id))!.status).toBe('pending');
    fail = false;
    await h.drafts.send(d.id);
    expect((await h.drafts.get(d.id))!.status).toBe('sent');
    expect(env).toMatchObject({ from: 'me@qq.com', to: ['x@y.z'] });
  });

  it('SMTP 成功后登记失败 → 抛「请勿重发」而非可重试文案', async () => {
    const h = makeHarness({ smtpSend: async () => { fs.rmSync(path.join(dir, 'drafts.json')); } });
    const d = await h.drafts.save(INPUT);
    await expect(h.drafts.send(d.id)).rejects.toThrow('请勿重发');
    await expect(h.drafts.send(d.id)).rejects.toThrow('不存在');
  });

  it('同一草稿并发 send → 第二次拒绝「正在发送中」', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const h = makeHarness({ smtpSend: async () => { await gate; } });
    const d = await h.drafts.save(INPUT);
    const first = h.drafts.send(d.id);
    await expect(h.drafts.send(d.id)).rejects.toThrow('正在发送中');
    release();
    await first;
    expect((await h.drafts.get(d.id))!.status).toBe('sent');
  });
});
