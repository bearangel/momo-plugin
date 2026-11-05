// tests/email/store.test.ts
// node:sqlite 数据层：schema/WAL/版本护栏/legacy 清理/drafts 与 envelope 仓储语义
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createStore, SCHEMA_VERSION } from '../../plugins/email/service/lib/store';

interface Db {
  prepare(sql: string): {
    get(...args: unknown[]): Record<string, unknown> | undefined;
    all(...args: unknown[]): Record<string, unknown>[];
    run(...args: unknown[]): unknown;
  };
  exec(sql: string): void;
  close(): void;
}
const requireHere = createRequire(import.meta.url);
const { DatabaseSync } = requireHere('node:sqlite') as { DatabaseSync: new (file: string) => Db };

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-store-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const draft = (id: string, over: Record<string, unknown> = {}) => ({
  id, accountId: 'acc1', uid: 1, status: 'pending', to: ['x@y.z'], cc: [],
  subject: 's', fromAddr: 'me@qq.com', summary: 'sum', attachmentNames: [],
  inputPayload: { text: 'body' }, createdAt: '2026-11-05T00:00:00.000Z',
  sentAt: null, lastError: null, ...over,
});

describe('store', () => {
  it('v1 schema + user_version=1 + WAL 生效', () => {
    const store = createStore({ dataDir: dir });
    const db = new DatabaseSync(path.join(dir, 'data.db'));
    expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(SCHEMA_VERSION);
    expect(db.prepare('PRAGMA journal_mode').get()!.journal_mode).toBe('wal');
    db.close();
    store.close();
  });

  it('user_version>2 → 中文错误（不静默重建）', () => {
    const file = path.join(dir, 'data.db');
    const db = new DatabaseSync(file);
    db.exec('PRAGMA user_version=3');
    db.close();
    expect(() => createStore({ dataDir: dir })).toThrow('数据文件由更新版本插件创建');
  });

  it('v1 → v2 迁移：补建 folder_cache 并置 user_version=2', () => {
    const first = createStore({ dataDir: dir });
    first.close();
    const file = path.join(dir, 'data.db');
    const db = new DatabaseSync(file);
    db.exec('DROP TABLE folder_cache');
    db.exec('PRAGMA user_version=1');
    db.close();
    const store = createStore({ dataDir: dir });
    expect(store.readFoldersCache('acc1')).toBeNull();
    store.writeFoldersCache('acc1', { drafts: 'Drafts', sent: null });
    expect(store.readFoldersCache('acc1')!.value).toEqual({ drafts: 'Drafts', sent: null });
    const check = new DatabaseSync(file);
    expect(check.prepare('PRAGMA user_version').get()!.user_version).toBe(2);
    check.close();
    store.close();
  });

  it('folder_cache：读写 + 损坏 payload 返回 null', () => {
    const store = createStore({ dataDir: dir });
    store.writeFoldersCache('acc1', { drafts: '草稿箱', sent: '已发送', unseen: { INBOX: 2 } });
    const hit = store.readFoldersCache('acc1')!;
    expect(hit.value.drafts).toBe('草稿箱');
    expect(hit.savedAt).toBeGreaterThan(0);
    store.close();
    const db = new DatabaseSync(path.join(dir, 'data.db'));
    db.prepare('UPDATE folder_cache SET payload_json = ? WHERE account_id = ?').run('{broken', 'acc1');
    db.close();
    const store2 = createStore({ dataDir: dir });
    expect(store2.readFoldersCache('acc1')).toBeNull();
    store2.close();
  });

  it('损坏 DB → 中文错误，不重建', () => {
    fs.writeFileSync(path.join(dir, 'data.db'), 'not a database');
    expect(() => createStore({ dataDir: dir })).toThrow(/数据/);
  });

  it('legacy 清理：旧 drafts.json + cache/ 在 init 后消失', () => {
    fs.writeFileSync(path.join(dir, 'drafts.json'), '[]');
    fs.mkdirSync(path.join(dir, 'cache', 'acc1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'cache', 'acc1', 'INBOX.json'), '{}');
    const store = createStore({ dataDir: dir });
    expect(fs.existsSync(path.join(dir, 'drafts.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'cache'))).toBe(false);
    store.close();
  });

  it('drafts：insert/list(rowid 升序)/get/update/delete', () => {
    const store = createStore({ dataDir: dir });
    store.insertDraft(draft('d1'));
    store.insertDraft(draft('d2', { status: 'sent', sentAt: '2026-11-05T01:00:00.000Z' }));
    expect(store.listDrafts().map((r) => r.id)).toEqual(['d1', 'd2']);
    expect(store.getDraft('d2')!.status).toBe('sent');
    store.updateDraft('d1', { ...store.getDraft('d1')!, status: 'discarded', expireReason: 'x' });
    expect(store.getDraft('d1')!.status).toBe('discarded');
    expect(store.getDraft('d1')!.expireReason).toBe('x');
    expect(() => store.updateDraft('nope', draft('nope'))).toThrow('草稿不存在');
    store.deleteDrafts(['d1']);
    expect(store.listDrafts().map((r) => r.id)).toEqual(['d2']);
    store.close();
  });

  it('envelopes：uid 降序、500 上限、覆盖写、cutoff 过滤（date_ms=0 保留）', () => {
    const store = createStore({ dataDir: dir });
    const many = Array.from({ length: 501 }, (_, i) => ({ uid: i + 1, date: '2026-11-05T00:00:00Z' }));
    store.writeEnvelopes('acc1', 'INBOX', many);
    const hit = store.readEnvelopes('acc1', 'INBOX')!;
    expect(hit.items).toHaveLength(500);
    expect(hit.items[0]!.uid).toBe(501);
    expect(hit.savedAt).toBeGreaterThan(0);

    store.writeEnvelopes('acc1', 'INBOX', [{ uid: 9, date: '2026-11-05T00:00:00Z' }]);
    expect(store.readEnvelopes('acc1', 'INBOX')!.items.map((e) => e.uid)).toEqual([9]);

    const cutoff = Date.parse('2024-01-01T00:00:00Z');
    store.writeEnvelopes('acc1', 'OLD', [
      { uid: 1, date: '2020-01-01T00:00:00Z' },
      { uid: 2, date: '2025-01-01T00:00:00Z' },
      { uid: 3 },
    ], { cutoffMs: cutoff });
    expect(store.readEnvelopes('acc1', 'OLD')!.items.map((e) => e.uid)).toEqual([3, 2]);
    store.close();
  });
});

describe('local_archive（schema v3）', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    accountId: 'a', folder: 'INBOX', uid: 7, rootId: 'r1',
    relPath: 'a/INBOX/2026-11/7-abc12345.eml.enc', sizeBytes: 100, sha256: 'h',
    encVersion: 1, msgDate: 1790000000000, state: 'ok', cachedAt: 1790000000000, ...over,
  });

  it('v2 存量库 → 打开即迁移到 v3（local_archive 可用）', () => {
    const s1 = createStore({ dataDir: dir });
    s1.close();
    const db = new DatabaseSync(path.join(dir, 'data.db'));
    db.exec('PRAGMA user_version=2');
    db.close();
    const s2 = createStore({ dataDir: dir });
    expect(s2.getArchiveRow('a', 'INBOX', 1)).toBeNull();
    s2.close();
    const db2 = new DatabaseSync(path.join(dir, 'data.db'));
    expect(db2.prepare('PRAGMA user_version').get()!.user_version).toBe(3);
    db2.close();
  });

  it('upsert 幂等覆盖 / 状态流转 / uid 过滤删除 / 统计', () => {
    const s = createStore({ dataDir: dir });
    s.upsertArchiveRow(row());
    expect(s.getArchiveRow('a', 'INBOX', 7)!.relPath).toBe('a/INBOX/2026-11/7-abc12345.eml.enc');
    s.upsertArchiveRow(row({ sizeBytes: 200 }));
    expect(s.getArchiveRow('a', 'INBOX', 7)!.sizeBytes).toBe(200);
    s.setArchiveState('a', 'INBOX', 7, 'missing');
    expect(s.getArchiveRow('a', 'INBOX', 7)!.state).toBe('missing');
    s.upsertArchiveRow(row({ uid: 8, state: 'corrupt', sizeBytes: 1 }));
    s.upsertArchiveRow(row({ uid: 9, state: 'too_large', sizeBytes: 0 }));
    expect(s.archiveStats('r1')).toEqual({ files: 3, bytes: 201, missing: 1, corrupt: 1, tooLarge: 1 });
    expect(s.deleteArchiveRows('a', { folder: 'INBOX', uid: 8 })).toBe(1);
    expect(s.getArchiveRow('a', 'INBOX', 8)).toBeNull();
    expect(s.listArchiveRows('a', { state: 'ok' })).toHaveLength(2);
    expect(s.deleteArchiveRows('a', { folder: 'INBOX' })).toBe(2);
    expect(s.getArchiveRow('a', 'INBOX', 7)).toBeNull();
    s.close();
  });

  it('archiveAccountsOfRoot 按 rootId 聚合账号集合', () => {
    const s = createStore({ dataDir: dir });
    s.upsertArchiveRow(row());
    s.upsertArchiveRow(row({ accountId: 'b', uid: 1 }));
    s.upsertArchiveRow(row({ accountId: 'c', rootId: 'r-old', uid: 2 }));
    expect(s.archiveAccountsOfRoot('r1').sort()).toEqual(['a', 'b']);
    s.close();
  });
});
