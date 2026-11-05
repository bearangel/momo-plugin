// tests/email/archive.test.ts
//
// 本地归档模块（spec 2026-11-05 §4/§7/§8/§9/§12）：加密落盘 + 路径索引 +
// rootId 换根隔离 + 保留清理 + 启动自愈 + setRoot 校验。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createStore } from '../../plugins/email/service/lib/store';
import { createArchive } from '../../plugins/email/service/lib/archive';

let dataDir: string;
let root: string;
let store: ReturnType<typeof createStore>;
const secretBox = new Map<string, string>();
const fakeSecrets = {
  async get(k: string) { return secretBox.get(k) ?? null; },
  async set(k: string, v: string) { secretBox.set(k, v); },
  async delete(k: string) { secretBox.delete(k); },
};
const logger = { warn: () => undefined, info: () => undefined, error: () => undefined };

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-data-'));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-root-'));
  store = createStore({ dataDir });
});
afterEach(() => {
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

const mk = () => createArchive({ dataDir, store, secrets: fakeSecrets, logger });

describe('archive', () => {
  it('write→read round-trip：文件为密文、索引行 ok', async () => {
    const arc = mk();
    await arc.setRoot(root);
    const raw = Buffer.from('From: a@b\r\nSubject: t\r\n\r\nhello 你好');
    const w = await arc.write('acc1', 'INBOX', 42, raw, Date.now());
    expect(w.stored).toBe(true);
    const hit = await arc.read('acc1', 'INBOX', 42);
    expect(hit?.raw.equals(raw)).toBe(true);
    const row = store.getArchiveRow('acc1', 'INBOX', 42)!;
    expect(row.state).toBe('ok');
    expect(row.rootId).toBeTruthy();
    const buf = fs.readFileSync(path.join(root, row.relPath));
    expect(buf.subarray(0, 7).toString()).toBe('MOMAIL1');
    expect(buf.indexOf(Buffer.from('hello'))).toBe(-1);
  });

  it('>25MB 不落盘标记 too_large；小文件正常落', async () => {
    const arc = mk();
    await arc.setRoot(root);
    const w = await arc.write('acc1', 'INBOX', 1, Buffer.alloc(25 * 1024 * 1024 + 1), Date.now());
    expect(w.stored).toBe(false);
    expect(w.reason).toBe('too_large');
    expect(store.getArchiveRow('acc1', 'INBOX', 1)!.state).toBe('too_large');
    const w2 = await arc.write('acc1', 'INBOX', 2, Buffer.alloc(1024), Date.now());
    expect(w2.stored).toBe(true);
  });

  it('文件截断 → read 返回 null，自愈 corrupt + 删文件', async () => {
    const arc = mk();
    await arc.setRoot(root);
    await arc.write('acc1', 'INBOX', 5, Buffer.from('secret'), Date.now());
    const row = store.getArchiveRow('acc1', 'INBOX', 5)!;
    const abs = path.join(root, row.relPath);
    fs.writeFileSync(abs, fs.readFileSync(abs).subarray(0, 30));
    expect(await arc.read('acc1', 'INBOX', 5)).toBeNull();
    expect(store.getArchiveRow('acc1', 'INBOX', 5)!.state).toBe('corrupt');
    expect(fs.existsSync(abs)).toBe(false);
  });

  it('文件被整封替换（换 uid 的合法密文）→ AAD 认证失败自愈', async () => {
    const arc = mk();
    await arc.setRoot(root);
    await arc.write('acc1', 'INBOX', 6, Buffer.from('mine'), Date.now());
    await arc.write('acc1', 'INBOX', 7, Buffer.from('other'), Date.now());
    const row6 = store.getArchiveRow('acc1', 'INBOX', 6)!;
    const row7 = store.getArchiveRow('acc1', 'INBOX', 7)!;
    fs.copyFileSync(path.join(root, row7.relPath), path.join(root, row6.relPath));
    expect(await arc.read('acc1', 'INBOX', 6)).toBeNull();
    expect(store.getArchiveRow('acc1', 'INBOX', 6)!.state).toBe('corrupt');
  });

  it('root 切换：旧行不命中；clearCurrent 只清当前 root 的文件与索引', async () => {
    const arc = mk();
    await arc.setRoot(root);
    await arc.write('acc1', 'INBOX', 9, Buffer.from('x'), Date.now());
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-root2-'));
    try {
      await arc.setRoot(root2);
      expect(await arc.read('acc1', 'INBOX', 9)).toBeNull();
      await arc.write('acc1', 'INBOX', 9, Buffer.from('x'), Date.now());
      const row = store.getArchiveRow('acc1', 'INBOX', 9)!;
      expect(fs.existsSync(path.join(root2, row.relPath))).toBe(true);
      const r = await arc.clearCurrent();
      expect(r.removed).toBeGreaterThanOrEqual(1);
      expect(await arc.read('acc1', 'INBOX', 9)).toBeNull();
      expect(store.listArchiveRows('acc1')).toHaveLength(0);
    } finally {
      fs.rmSync(root2, { recursive: true, force: true });
    }
  });

  it('setRoot 校验：相对路径/文件/文件系统根拒绝', async () => {
    const arc = mk();
    await expect(arc.setRoot('relative/x')).rejects.toThrow(/绝对路径/);
    const file = path.join(root, 'f.txt');
    fs.writeFileSync(file, 'x');
    await expect(arc.setRoot(file)).rejects.toThrow(/目录/);
    await expect(arc.setRoot(path.parse(root).root)).rejects.toThrow(/根目录/);
  });

  it('prune 按 msgDate 清理；msgDate=0 与新邮件保留', async () => {
    const arc = mk();
    await arc.setRoot(root);
    const old = Date.now() - 40 * 86400000;
    await arc.write('acc1', 'INBOX', 1, Buffer.from('old'), old);
    await arc.write('acc1', 'INBOX', 2, Buffer.from('new'), Date.now());
    await arc.write('acc1', 'INBOX', 3, Buffer.from('unk'), 0);
    const r = await arc.prune('acc1', 'INBOX', Date.now() - 30 * 86400000);
    expect(r.removed).toBe(1);
    expect(await arc.read('acc1', 'INBOX', 1)).toBeNull();
    expect(await arc.read('acc1', 'INBOX', 2)).not.toBeNull();
    expect(await arc.read('acc1', 'INBOX', 3)).not.toBeNull();
  });

  it('removeAccount 双侧清理；verifyStartup 修 missing 与删孤儿', async () => {
    const arc = mk();
    await arc.setRoot(root);
    await arc.write('acc1', 'INBOX', 1, Buffer.from('a'), Date.now());
    const row = store.getArchiveRow('acc1', 'INBOX', 1)!;
    fs.rmSync(path.join(root, row.relPath));
    fs.mkdirSync(path.join(root, 'acc1', 'INBOX', '2026-11'), { recursive: true });
    fs.writeFileSync(path.join(root, 'acc1', 'INBOX', '2026-11', 'zzz.eml.enc'), 'junk');
    const v = await arc.verifyStartup(['acc1']);
    expect(v.fixedMissing).toBe(1);
    expect(v.removedOrphans).toBe(1);
    await arc.write('acc1', 'INBOX', 2, Buffer.from('b'), Date.now());
    const r = await arc.removeAccount('acc1');
    expect(r.removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(root, 'acc1'))).toBe(false);
    expect(store.listArchiveRows('acc1')).toHaveLength(0);
  });

  it('未配置 root：write 返回 disabled、read 返回 null，均不抛', async () => {
    const arc = mk();
    expect(await arc.write('a', 'INBOX', 1, Buffer.from('x'), 0)).toMatchObject({ stored: false, reason: 'disabled' });
    expect(await arc.read('a', 'INBOX', 1)).toBeNull();
    expect(await arc.verifyStartup(['a'])).toEqual({ fixedMissing: 0, removedOrphans: 0 });
  });

  it('路径段消毒：folder/accountId 带 .. 或反斜杠拒绝并落 corrupt 语义不适用（直接抛）', async () => {
    const arc = mk();
    await arc.setRoot(root);
    await expect(arc.write('a/../b', 'INBOX', 1, Buffer.from('x'), 0)).rejects.toThrow(/非法/);
    await expect(arc.write('a', 'INBOX/x\\y', 1, Buffer.from('x'), 0)).rejects.toThrow(/非法/);
  });

  it('stats 汇总（enabled/rootPath/计数）', async () => {
    const arc = mk();
    await arc.setRoot(root);
    await arc.write('acc1', 'INBOX', 1, Buffer.from('abc'), Date.now());
    const s = await arc.stats();
    expect(s.enabled).toBe(true);
    expect(s.rootPath).toBe(fs.realpathSync(root));
    expect(s.files).toBe(1);
    expect(s.bytes).toBeGreaterThan(0);
  });
});

describe('prune 按 folder 限定（发件箱永久，spec §1.1/§9）', () => {
  it('同账号两文件夹均过期：只清指定 folder，另一 folder 行与文件保留', async () => {
    const arc = mk();
    await arc.setRoot(root);
    const old = Date.now() - 40 * 86400000;
    await arc.write('acc1', 'INBOX', 1, Buffer.from('a'), old);
    await arc.write('acc1', 'Sent Messages', 1, Buffer.from('s'), old);
    const cutoff = Date.now() - 30 * 86400000;
    const r = await arc.prune('acc1', 'INBOX', cutoff);
    expect(r.removed).toBe(1);
    expect(await arc.read('acc1', 'INBOX', 1)).toBeNull();
    expect(await arc.read('acc1', 'Sent Messages', 1)).not.toBeNull();
  });
});
