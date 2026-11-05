// tests/email/service-envelope-cache.test.ts
// 有界淘汰 / 覆盖写 / folder 隔离 / 名称消毒 / DB 损坏（真实 node:sqlite store）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createEnvelopeCache } from '../../plugins/email/service/lib/envelope-cache';
import { createStore } from '../../plugins/email/service/lib/store';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-cache-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const mk = (uid: number, date = '2026-11-01T00:00:00Z') => ({
  uid, subject: `s${uid}`, from: 'a@b.c', to: 'd@e.f', date, seen: false, hasAttachments: false, size: 100,
});

function makeCache() {
  const store = createStore({ dataDir: dir });
  return { store, cache: createEnvelopeCache({ store }) };
}

describe('envelope cache', () => {
  it('write→read 回读为 uid 降序并携带 savedAt', () => {
    const { store, cache } = makeCache();
    cache.write('acc1', 'INBOX', [mk(1), mk(2)]);
    const hit = cache.read('acc1', 'INBOX')!;
    expect(hit.items.map((e: { uid: number }) => e.uid)).toEqual([2, 1]);
    expect(hit.savedAt).toBeGreaterThan(0);
    store.close();
  });

  it('有界 500 条：写 501 只留最新 500（uid 最大在前）', () => {
    const { store, cache } = makeCache();
    cache.write('acc1', 'INBOX', Array.from({ length: 501 }, (_, i) => mk(i + 1)));
    const hit = cache.read('acc1', 'INBOX')!;
    expect(hit.items.length).toBe(500);
    expect(hit.items[0]!.uid).toBe(501);
    store.close();
  });

  it('同键覆盖写：旧 items 不残留；不同 folder 隔离', () => {
    const { store, cache } = makeCache();
    cache.write('acc1', 'INBOX', [mk(1), mk(2)]);
    cache.write('acc1', 'INBOX', [mk(9)]);
    expect(cache.read('acc1', 'INBOX')!.items.map((e: { uid: number }) => e.uid)).toEqual([9]);
    cache.write('acc1', 'Sent', [mk(3)]);
    expect(cache.read('acc1', 'Sent')!.items.map((e: { uid: number }) => e.uid)).toEqual([3]);
    store.close();
  });

  it('invalidate 清空该键（items + meta）', () => {
    const { store, cache } = makeCache();
    cache.write('acc1', 'INBOX', [mk(1)]);
    cache.invalidate('acc1', 'INBOX');
    expect(cache.read('acc1', 'INBOX')).toBeNull();
    store.close();
  });

  it('非法 accountId/folder 抛错（不吞成 null）', () => {
    const { store, cache } = makeCache();
    expect(() => cache.write('acc1', '../evil', [mk(1)])).toThrow('folder');
    expect(() => cache.write('acc1', 'a/../b', [mk(1)])).toThrow('folder');
    expect(() => cache.write('../../evil', 'INBOX', [mk(1)])).toThrow('accountId');
    expect(() => cache.read('../../evil', 'INBOX')).toThrow('accountId');
    cache.write('acc1', 'INBOX/Sub', [mk(1)]);
    expect(cache.read('acc1', 'INBOX/Sub')!.items).toHaveLength(1);
    store.close();
  });

  it('DB 文件损坏 → createStore 抛中文错误', () => {
    fs.writeFileSync(path.join(dir, 'data.db'), 'not a database');
    expect(() => createStore({ dataDir: dir })).toThrow(/数据/);
  });
});
