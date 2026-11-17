// 引擎主体单测：fake 驱动注入——configure diff / 只读校验接线 / 未配置连接错误 / 未知方法
import { describe, it, expect, vi } from 'vitest';
import engineMod from '../../plugins/db-pro/engine/engine.js';
const { createDispatcher } = engineMod;

function fakeDriver() {
  const closed = [];
  const pool = {
    dialect: 'mysql',
    ping: async () => undefined,
    query: async () => ({ columns: ['a'], rows: [[1]], total: 1, truncated: false }),
    listSchemas: async () => ['s1'],
    listTables: async () => [{ schema: 's1', name: 't1', type: 'table' }],
    listViews: async () => [],
    describe: async () => ({ columns: [], indexes: [], rowEstimate: 1 }),
    columns: async () => [],
    ddl: async () => 'CREATE TABLE t1 (a int)',
    explain: async () => ({ text: 'plan', operators: [], summary: '' }),
    exec: async () => ({ affectedRows: 1 }),
    close: async () => { closed.push(true); },
  };
  return { pool, closed };
}

const CFG = (url = 'mysql://u:p@h:3306/db') => [{ name: 'c1', url, queryTimeoutMs: 30000 }];

describe('createDispatcher', () => {
  it('configure 建池 + query 全链（只读校验通过）', async () => {
    const f = fakeDriver();
    const d = createDispatcher(() => ({ createPool: async () => f.pool }));
    const r = await d.dispatch('configure', { connections: CFG() });
    expect(r.configured).toBe(1);
    const q = await d.dispatch('query', { connection: 'c1', sql: 'SELECT 1', maxRows: 10 });
    expect(q.rows).toEqual([[1]]);
  });

  it('query 写语句被只读校验拒绝（readonly_rejected），不到驱动', async () => {
    const f = fakeDriver();
    const d = createDispatcher(() => ({ createPool: async () => f.pool }));
    await d.dispatch('configure', { connections: CFG() });
    await expect(d.dispatch('query', { connection: 'c1', sql: 'DELETE FROM t' }))
      .rejects.toMatchObject({ code: 'readonly_rejected' });
  });

  it('configure diff：URL 变更 → 旧池 close、新池建立', async () => {
    const f1 = fakeDriver();
    const f2 = fakeDriver();
    let which = 0;
    const d = createDispatcher(() => ({ createPool: async () => (which === 0 ? f1.pool : f2.pool) }));
    await d.dispatch('configure', { connections: CFG() });
    which = 1;
    await d.dispatch('configure', { connections: CFG('mysql://u:p@h:3306/db2') });
    expect(f1.closed).toHaveLength(1);
    const q = await d.dispatch('query', { connection: 'c1', sql: 'SELECT 1' });
    expect(q.rows).toEqual([[1]]);
  });

  it('未配置连接 → connection_failed；未知方法 → unknown_method', async () => {
    const d = createDispatcher(() => ({ createPool: async () => fakeDriver().pool }));
    await expect(d.dispatch('connTest', { name: 'nope' })).rejects.toMatchObject({ code: 'connection_failed' });
    await expect(d.dispatch('bogus', {})).rejects.toMatchObject({ code: 'unknown_method' });
  });

  it('exec 直通驱动（service 批准后路径，引擎不校验——信任边界在 service）', async () => {
    const f = fakeDriver();
    const d = createDispatcher(() => ({ createPool: async () => f.pool }));
    await d.dispatch('configure', { connections: CFG() });
    const r = await d.dispatch('exec', { connection: 'c1', sql: 'UPDATE t SET a=1' });
    expect(r.affectedRows).toBe(1);
  });
});

// 终审 C2：explain 路径前置只读校验（EXPLAIN ANALYZE 在 PG 会真实执行写语句）
describe('explain 前置只读校验（终审 C2）', () => {
  it('explain_query 传 ANALYZE DELETE → readonly_rejected', async () => {
    const f = fakeDriver();
    const d = createDispatcher(() => ({ createPool: async () => f.pool }));
    await d.dispatch('configure', { connections: CFG() });
    const explainSpy = vi.spyOn(f.pool, 'explain');
    await expect(d.dispatch('explain', { connection: 'c1', sql: 'ANALYZE DELETE FROM t' }))
      .rejects.toMatchObject({ code: 'readonly_rejected' });
    expect(explainSpy).not.toHaveBeenCalled();
  });
  it('合法 SELECT 的 explain 不受影响', async () => {
    const f = fakeDriver();
    const d = createDispatcher(() => ({ createPool: async () => f.pool }));
    await d.dispatch('configure', { connections: CFG() });
    const r = await d.dispatch('explain', { connection: 'c1', sql: 'SELECT * FROM t' });
    expect(r.text).toBe('plan');
  });
});
