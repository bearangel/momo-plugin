// tests/email/service-accounts.test.ts
// 脱敏形状 / 明文拒绝 / 密码走 secrets / 损坏容错 / 健康态（Review Focus 1/2/5）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccountStore, PRESETS } from '../../plugins/email/service/lib/accounts';

function makeSecrets() {
  const m = new Map<string, string>();
  return {
    m,
    async get(k: string) { return m.get(k) ?? null; },
    async set(k: string, v: string) { m.set(k, v); },
    async delete(k: string) { m.delete(k); },
  };
}

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-acc-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('accounts store', () => {
  it('add→list：记录无任何密码字段（脱敏），凭据只进 secrets', async () => {
    const secrets = makeSecrets();
    const store = createAccountStore({ dataDir: dir, secrets });
    const rec = await store.add({
      email: 'me@qq.com', displayName: '我', username: 'me@qq.com', password: 'auth-code',
      imap: { host: 'imap.qq.com', port: 993, tlsMode: 'tls' },
      smtp: { host: 'smtp.qq.com', port: 465, tlsMode: 'tls' },
    });
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    const s = JSON.stringify(listed[0]);
    expect(s).not.toContain('auth-code');
    expect(s).not.toContain('password');
    expect(secrets.m.get(`account:${rec.id}`)).toBe('auth-code');
  });

  it('明文/非法 tlsMode 拒绝（双守门第一道）', async () => {
    const store = createAccountStore({ dataDir: dir, secrets: makeSecrets() });
    await expect(store.add({
      email: 'a@b.c', username: 'a@b.c', password: 'x',
      imap: { host: 'h', port: 143, tlsMode: 'plain' as never },
      smtp: { host: 'h', port: 465, tlsMode: 'tls' },
    })).rejects.toThrow('tlsMode');
    await expect(store.add({
      email: 'a@b.c', username: 'a@b.c', password: 'x',
      imap: { host: 'h', port: 0, tlsMode: 'tls' },
      smtp: { host: 'h', port: 465, tlsMode: 'tls' },
    })).rejects.toThrow('端口');
  });

  it('update 不触碰密码；remove 连带清 secrets；email 唯一', async () => {
    const secrets = makeSecrets();
    const store = createAccountStore({ dataDir: dir, secrets });
    const a = await store.add({ email: 'a@b.c', username: 'a@b.c', password: 'p1',
      imap: PRESETS.qq.imap, smtp: PRESETS.qq.smtp });
    await store.update(a.id, { displayName: '改名' });
    expect(secrets.m.get(`account:${a.id}`)).toBe('p1');
    await expect(store.add({ email: 'a@b.c', username: 'a@b.c', password: 'p2',
      imap: PRESETS.qq.imap, smtp: PRESETS.qq.smtp })).rejects.toThrow('已存在');
    await store.remove(a.id);
    expect(secrets.m.has(`account:${a.id}`)).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it('accounts.json 损坏 → 空表重建不抛', async () => {
    fs.writeFileSync(path.join(dir, 'accounts.json'), '{broken', 'utf-8');
    const store = createAccountStore({ dataDir: dir, secrets: makeSecrets() });
    expect(await store.list()).toEqual([]);
  });

  it('markHealth 落账号健康态', async () => {
    const store = createAccountStore({ dataDir: dir, secrets: makeSecrets() });
    const a = await store.add({ email: 'a@b.c', username: 'a@b.c', password: 'p',
      imap: PRESETS.qq.imap, smtp: PRESETS.qq.smtp });
    await store.markHealth(a.id, 'error', '认证失败：授权码可能过期');
    expect((await store.get(a.id))!.health).toEqual({ state: 'error', message: '认证失败：授权码可能过期' });
  });
});
