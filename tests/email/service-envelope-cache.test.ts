// tests/email/service-envelope-cache.test.ts
// 有界淘汰 / 损坏重建 / 路径消毒（Review Focus 5）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createEnvelopeCache } from '../../plugins/email/service/lib/envelope-cache';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-cache-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const mk = (uid: number, date = '2026-11-01T00:00:00Z') => ({
  uid, subject: `s${uid}`, from: 'a@b.c', to: 'd@e.f', date, seen: false, hasAttachments: false, size: 100,
});

describe('envelope cache', () => {
  it('write→read 回读并携带 savedAt 元数据；升序入参落盘后为降序', () => {
    const c = createEnvelopeCache({ dataDir: dir });
    c.write('acc1', 'INBOX', [mk(1), mk(2)]);
    const hit = c.read('acc1', 'INBOX')!;
    expect(hit.items.map((e: { uid: number }) => e.uid)).toEqual([2, 1]);
    expect(typeof hit.savedAt).toBe('number');
  });

  it('有界 500 条：写 501 只留最新 500（uid 最大在前）', () => {
    const c = createEnvelopeCache({ dataDir: dir });
    const batch = Array.from({ length: 501 }, (_, i) => mk(i + 1));
    c.write('acc1', 'INBOX', batch);
    const hit = c.read('acc1', 'INBOX')!;
    expect(hit.items.length).toBe(500);
    expect(hit.items[0]!.uid).toBe(501);
  });

  it('损坏 JSON → read 返回 null（丢弃重建）', () => {
    const c = createEnvelopeCache({ dataDir: dir });
    c.write('acc1', 'INBOX', [mk(1)]);
    fs.writeFileSync(path.join(dir, 'cache', 'acc1', 'INBOX.json'), '{broken', 'utf-8');
    expect(c.read('acc1', 'INBOX')).toBeNull();
  });

  it('folder 名含路径段/穿越拒绝；层级分隔合法可写', () => {
    const c = createEnvelopeCache({ dataDir: dir });
    expect(() => c.write('acc1', '../evil', [mk(1)])).toThrow('folder');
    expect(() => c.write('acc1', 'a/../b', [mk(1)])).toThrow('folder');
    c.write('acc1', 'INBOX/Sub', [mk(1)]);
    expect(c.read('acc1', 'INBOX/Sub')!.items).toHaveLength(1);
  });

  it('accountId 路径段穿越拒绝：write/read 均抛出（read 不得吞成 null）', () => {
    const c = createEnvelopeCache({ dataDir: dir });
    expect(() => c.write('../../evil', 'INBOX', [mk(1)])).toThrow('accountId');
    expect(() => c.read('../../evil', 'INBOX')).toThrow('accountId');
  });
});
