import { describe, it, expect } from 'vitest';
import m from '../../plugins/db-pro/engine/drivers/oracle.js';
const { parseUrl, countSql } = m;

describe('oracle parseUrl', () => {
  it('常规形态（服务名进 connectString）', () => {
    expect(parseUrl('oracle://dbpro:dbpro123@127.0.0.1:11521/FREEPDB1').connectString)
      .toBe('127.0.0.1:11521/FREEPDB1');
  });
  it('缺服务名拒绝（thin 必须服务名连接）', () => {
    expect(() => parseUrl('oracle://u:p@h:1521')).toThrow(/服务名/);
  });
  it('URL 编码密码', () => {
    expect(parseUrl('oracle://u:p%40w@h:1521/SVC').password).toBe('p@w');
  });
});

describe('oracle countSql（spec 2026-11-20 §7.2 核验快照）', () => {
  it('合法表名 → 双引号包裹 COUNT', () => {
    expect(countSql('DBPRO_T')).toBe('SELECT COUNT(*) AS C FROM "DBPRO_T"');
  });
  it('非法标识符 → null', () => {
    expect(countSql('a b')).toBeNull();
    expect(countSql('t;')).toBeNull();
  });
});
