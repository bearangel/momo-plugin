// tests/db-pro/connections-store.test.mjs
// 连接存储（spec 2026-11-19 §6.1/§6.2）：元数据 connections.json + keytar 密钥 + 旧配置迁移。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import m from '../../plugins/db-pro/service/connections-store.js';
const { createConnectionsStore } = m;

function mkStore(initialSecrets = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbpro-conns-'));
  const kv = new Map(Object.entries(initialSecrets));
  const secrets = {
    async get(k) { return kv.get(k) ?? null; },
    async set(k, v) { kv.set(k, v); },
    async delete(k) { kv.delete(k); },
    kv,
  };
  return { dir, kv, secrets, store: createConnectionsStore({ dataDir: dir, secrets, log: () => undefined }) };
}

describe('connections-store CRUD', () => {
  it('create 校验名称唯一/URL scheme；URL 只入 secrets，投影不含明文', async () => {
    const { store, kv } = mkStore();
    const rec = await store.create({ name: 'dev', description: '开发库', url: 'mysql://u:secret@h:3306/d', permissions: ['query'] });
    expect(rec.id).toMatch(/^c_[a-z0-9]+$/);
    expect(kv.get(`conn.${rec.id}.url`)).toContain('secret');
    const proj = store.listProjection();
    expect(JSON.stringify(proj)).not.toContain('secret');
    expect(proj[0]).toMatchObject({ name: 'dev', dialect: 'mysql', hasUrl: true, permissions: ['query'] });
    await expect(store.create({ name: 'dev', url: 'mysql://u:p@h/d' })).rejects.toThrow(/已存在/);
    await expect(store.create({ name: 'bad', url: 'sqlite://x' })).rejects.toThrow(/协议/);
  });

  it('update 改名/改权限；remove 清密钥；setDefault 单点', async () => {
    const { store, kv } = mkStore();
    const a = await store.create({ name: 'a', url: 'mysql://u:p@h/a', permissions: ['query'] });
    const b = await store.create({ name: 'b', url: 'postgres://u:p@h/b', permissions: ['query'] });
    await store.update(a.id, { name: 'a2', permissions: ['query', 'insert'] });
    expect(store.listProjection().find((x) => x.id === a.id)).toMatchObject({ name: 'a2', permissions: ['query', 'insert'] });
    await store.setDefault(b.id);
    expect(store.listProjection().filter((x) => x.isDefault)).toHaveLength(1);
    await store.remove(a.id);
    expect(kv.get(`conn.${a.id}.url`)).toBeUndefined();
    expect(store.listProjection()).toHaveLength(1);
  });

  it('listForEngine 实时解析 URL；secrets 缺失的连接跳过并告警', async () => {
    const { store, secrets } = mkStore();
    await store.create({ name: 'a', url: 'mysql://u:p@h/a', permissions: ['query'] });
    await store.create({ name: 'b', url: 'mysql://u:p@h/b', permissions: ['query'] });
    const projB = store.listProjection().find((x) => x.name === 'b');
    await secrets.delete(`conn.${projB.id}.url`);
    const rows = await store.listForEngine();
    expect(rows).toEqual([{ name: 'a', url: 'mysql://u:p@h/a', permissions: ['query'] }]);
  });

  it('新实例从磁盘恢复（重启语义）', async () => {
    const { dir, secrets } = mkStore();
    const s1 = createConnectionsStore({ dataDir: dir, secrets, log: () => undefined });
    await s1.create({ name: 'persist', url: 'mysql://u:p@h/p', permissions: ['query'] });
    const s2 = createConnectionsStore({ dataDir: dir, secrets, log: () => undefined });
    expect(s2.listProjection().map((x) => x.name)).toEqual(['persist']);
    await s2.warm();
    expect(s2.listProjection()[0]).toMatchObject({ dialect: 'mysql', hasUrl: true });
  });
});

describe('migrateLegacy（保等效）', () => {
  it('旧 conn1–6 导入：全权限位 + default 标记 + 清旧密钥；幂等', async () => {
    const legacy = {
      conn1_url: 'mysql://u:p@h/a', conn1_name: 'mysql',
      conn2_url: 'dm://SYSDBA:SYSDBA001@h:5236', conn2_name: 'dm_test',
      default_connection: 'dm_test',
    };
    const { store, kv, secrets } = mkStore({ conn1_url: legacy.conn1_url, conn2_url: legacy.conn2_url });
    await store.migrateLegacy(legacy);
    const proj = store.listProjection();
    expect(proj).toHaveLength(2);
    expect(proj.every((x) => x.permissions.length === 8)).toBe(true);
    expect(proj.find((x) => x.isDefault)?.name).toBe('dm_test');
    expect(kv.get('conn1_url')).toBeUndefined();
    expect(kv.get('conn2_url')).toBeUndefined();
    await store.migrateLegacy(legacy);
    expect(store.listProjection()).toHaveLength(2);
    void secrets;
  });

  it('无旧配置 → 不创建任何连接', async () => {
    const { store } = mkStore();
    const r = await store.migrateLegacy({});
    expect(r.migrated).toBe(0);
    expect(store.listProjection()).toHaveLength(0);
  });
});
