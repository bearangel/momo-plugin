import { describe, it, expect } from 'vitest';
import m from '../../plugins/db-pro/engine/drivers/pg.js';
const { parseUrl } = m;

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
