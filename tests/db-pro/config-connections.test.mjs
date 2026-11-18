import { describe, it, expect } from 'vitest';
import m from '../../plugins/db-pro/service/config-connections.js';
const { connectionsFromConfig, diffConnections } = m;

describe('connectionsFromConfig（槽位制，spec §4.3）', () => {
  it('空配置 → 空连接列表', () => {
    expect(connectionsFromConfig({})).toEqual([]);
  });
  it('槽位缺省名 conn<n>；空槽跳过；timeout 归一', () => {
    const conns = connectionsFromConfig({
      conn2_url: 'mysql://u:p@h/db2',
      conn3_url: 'dm://SYSDBA:SYSDBA@h:5236',
      conn3_name: 'prod_dm',
      query_timeout_ms: 5000,
    });
    expect(conns).toEqual([
      { name: 'conn2', url: 'mysql://u:p@h/db2', queryTimeoutMs: 5000 },
      { name: 'prod_dm', url: 'dm://SYSDBA:SYSDBA@h:5236', queryTimeoutMs: 5000 },
    ]);
  });
  it('连接名重复拒绝（人话错误）', () => {
    expect(() => connectionsFromConfig({
      conn1_url: 'mysql://u:p@h/a', conn1_name: 'dup',
      conn2_url: 'mysql://u:p@h/b', conn2_name: 'dup',
    })).toThrow(/重复/);
  });
  it('query_timeout_ms 负数/非有限数/过小 → 归 30000；过大 → 封顶 300000（用户 -40 实证回归锁）', () => {
    const mk = (v) => connectionsFromConfig({ conn1_url: 'mysql://u:p@h/d', query_timeout_ms: v })[0].queryTimeoutMs;
    expect(mk(-40)).toBe(30000);
    expect(mk(0)).toBe(30000);
    expect(mk(Number.NaN)).toBe(30000);
    expect(mk('abc')).toBe(30000);
    expect(mk(500)).toBe(30000);
    expect(mk(5000)).toBe(5000);
    expect(mk(999999)).toBe(300000);
  });
  it('URL 非字符串/空白按空槽处理', () => {
    expect(connectionsFromConfig({ conn1_url: '   ' })).toEqual([]);
  });
});

describe('diffConnections', () => {
  const A = [{ name: 'a', url: 'mysql://u:p@h/d', queryTimeoutMs: 30000 }];
  it('相同 → false', () => {
    expect(diffConnections(A, [{ name: 'a', url: 'mysql://u:p@h/d', queryTimeoutMs: 30000 }])).toBe(false);
  });
  it('URL 变化 / 增删连接 → true', () => {
    expect(diffConnections(A, [{ name: 'a', url: 'mysql://u:p@h/d2', queryTimeoutMs: 30000 }])).toBe(true);
    expect(diffConnections(A, [])).toBe(true);
    expect(diffConnections([], A)).toBe(true);
  });
});
