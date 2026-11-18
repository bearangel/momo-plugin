import { describe, it, expect } from 'vitest';
import m from '../../plugins/db-pro/engine/drivers/mysql.js';
const { parseUrl, quoteIdent } = m;

describe('mysql parseUrl', () => {
  it('常规形态', () => {
    const c = parseUrl('mysql://root:dbpro123@127.0.0.1:13306/dbpro');
    expect(c).toEqual({ host: '127.0.0.1', port: 13306, user: 'root', password: 'dbpro123', database: 'dbpro' });
  });
  it('URL 编码的特殊字符密码（@ 与 :）', () => {
    const c = parseUrl('mysql://u:p%40ss%3Aword@h:3306/db');
    expect(c.password).toBe('p@ss:word');
  });
  it('缺端口默认 3306', () => {
    expect(parseUrl('mysql://u:p@h/db').port).toBe(3306);
  });
  it('非 mysql 协议拒绝', () => {
    expect(() => parseUrl('postgres://u:p@h/db')).toThrow(/mysql/);
  });
});

describe('mysql quoteIdent', () => {
  it('合法标识符加反引号', () => expect(quoteIdent('dbpro')).toBe('`dbpro`'));
  it('注入面拒绝（分号/点/空格）', () => {
    expect(() => quoteIdent('a;b')).toThrow();
    expect(() => quoteIdent('a.b')).toThrow();
    expect(() => quoteIdent('a b')).toThrow();
  });
});
