import { describe, it, expect } from 'vitest';
import m from '../../plugins/db-pro/engine/drivers/pg.js';
const { parseUrl, countSql } = m;

describe('pg parseUrl', () => {
  it('常规形态', () => {
    expect(parseUrl('postgres://u:p@127.0.0.1:15432/dbpro')).toEqual({
      host: '127.0.0.1', port: 15432, user: 'u', password: 'p', database: 'dbpro',
    });
  });
  it('postgresql:// 别名与 URL 编码密码', () => {
    const c = parseUrl('postgresql://u:p%40w@h/db');
    expect(c.password).toBe('p@w');
  });
  it('缺端口默认 5432', () => {
    expect(parseUrl('postgres://u:p@h/db').port).toBe(5432);
  });
});

describe('pg countSql（spec 2026-11-20 §7.2 核验快照）', () => {
  it('合法表名 → 双引号包裹 COUNT', () => {
    expect(countSql('dbpro_t')).toBe('SELECT COUNT(*)::int AS c FROM "dbpro_t"');
  });
  it('非法标识符 → null（Review Focus 5）', () => {
    expect(countSql('a b')).toBeNull();
    expect(countSql('a;DROP')).toBeNull();
    expect(countSql('')).toBeNull();
  });
});
