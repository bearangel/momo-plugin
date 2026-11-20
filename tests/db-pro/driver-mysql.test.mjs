import { describe, it, expect } from 'vitest';
import m from '../../plugins/db-pro/engine/drivers/mysql.js';
const { parseUrl, quoteIdent, normalizeMysqlResults, createMysqlSession } = m;

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

describe('normalizeMysqlResults · CALL 结果集归一（spec 2026-11-20 §4.1/§7.1）', () => {
  const okPacket = (n) => ({ affectedRows: n });
  const rowSet = (cols, vals) => vals.map((v) => Object.fromEntries(cols.map((c, i) => [c, v[i]])));

  it('纯 OK 包：只有影响行数、无输出', () => {
    const r = normalizeMysqlResults(okPacket(3));
    expect(r).toEqual({ affectedRows: 3, outputs: null });
  });
  it('CALL [rows, ok]：输出捕获 + 尾部 OK 为影响行数', () => {
    const r = normalizeMysqlResults([rowSet(['execution_status'], [['[FAIL] S00971511 -- [23000] dup']]), okPacket(0)]);
    expect(r.affectedRows).toBe(0);
    expect(r.outputs).toEqual([{ columns: ['execution_status'], rows: [['[FAIL] S00971511 -- [23000] dup']] }]);
  });
  it('CALL [rows] 无尾 OK 包：影响行数 0 不炸（Review Focus 1）', () => {
    const r = normalizeMysqlResults([rowSet(['a'], [['x']])]);
    expect(r.affectedRows).toBe(0);
    expect(r.outputs.length).toBe(1);
    expect(r.outputs[0].rows).toEqual([['x']]);
  });
  it('多结果集 [ok, rows, ok]', () => {
    const r = normalizeMysqlResults([okPacket(1), rowSet(['a'], [['y']]), okPacket(5)]);
    expect(r.affectedRows).toBe(5);
    expect(r.outputs).toEqual([{ columns: ['a'], rows: [['y']] }]);
  });
  it('有界：行截 50、单元格截 200 字', () => {
    const many = Array.from({ length: 60 }, (_, i) => ['v' + i]);
    const r = normalizeMysqlResults([rowSet(['v'], many), okPacket(0)]);
    expect(r.outputs[0].rows.length).toBe(50);
    const r2 = normalizeMysqlResults([rowSet(['v'], [['x'.repeat(300)]])]);
    expect(r2.outputs[0].rows[0][0].length).toBe(200);
  });
  it('空结果集数组：无输出、0 行', () => {
    const r = normalizeMysqlResults([okPacket(2)]);
    expect(r).toEqual({ affectedRows: 2, outputs: null });
  });
});

describe('createMysqlSession · exec/count（spec 2026-11-20 §7.1/§7.2）', () => {
  function fakeConn(sends) {
    const log = [];
    return {
      log,
      async query(opts) {
        log.push(opts.sql);
        const r = sends.shift();
        if (typeof r === 'function') return r(opts.sql);
        return [r];
      },
      release() {},
    };
  }
  it('exec 走 normalizeMysqlResults', async () => {
    // 探查应答（会话=库默认，不发 SET NAMES）在前，exec 应答在后
    const conn = fakeConn([[{ cs: 'utf8mb4', dbColl: 'c', connColl: 'c' }], [{ a: '[FAIL] x' }]]);
    const s = createMysqlSession(conn, 30_000);
    const r = await s.exec('CALL sp()');
    expect(r.outputs[0].rows).toEqual([['[FAIL] x']]);
  });
  it('count：合法表名取回数值', async () => {
    const conn = fakeConn([[{ c: 5 }]]);
    const s = createMysqlSession(conn, 30_000);
    expect(await s.count('dbpro_t')).toBe(5);
    expect(conn.log[0]).toContain('COUNT(*)');
    expect(conn.log[0]).toContain('`dbpro_t`');
  });
  it('count：非法表名/查询失败 → null 不炸（Review Focus 5）', async () => {
    const conn = fakeConn([() => { throw new Error('syntax'); }]);
    const s = createMysqlSession(conn, 30_000);
    expect(await s.count('a b')).toBeNull();
    expect(await s.count('t2')).toBeNull();
  });
});

describe('createMysqlSession · collation 自动对齐（spec 2026-11-20 §5，R3）', () => {
  function fakeConn(sends) {
    const log = [];
    return {
      log,
      async query(opts) {
        log.push(opts.sql);
        const r = sends.shift();
        if (typeof r === 'function') return r(opts.sql);
        return [r];
      },
      release() {},
    };
  }
  it('会话 ≠ 库默认 → 首次 exec 前发 SET NAMES 对齐', async () => {
    const conn = fakeConn([
      [{ cs: 'utf8mb4', dbColl: 'utf8mb4_0900_ai_ci', connColl: 'utf8mb4_unicode_ci' }],
      { affectedRows: 0 },
      [{ affectedRows: 1 }],
    ]);
    const s = createMysqlSession(conn, 30_000);
    await s.exec('SELECT 1');
    expect(conn.log[0]).toContain('@@collation_database');
    expect(conn.log[1]).toBe('SET NAMES utf8mb4 COLLATE utf8mb4_0900_ai_ci');
    expect(conn.log[2]).toBe('SELECT 1');
  });
  it('会话 = 库默认 → 不发 SET NAMES', async () => {
    const conn = fakeConn([
      [{ cs: 'utf8mb4', dbColl: 'utf8mb4_0900_ai_ci', connColl: 'utf8mb4_0900_ai_ci' }],
      [{ affectedRows: 1 }],
    ]);
    const s = createMysqlSession(conn, 30_000);
    await s.exec('SELECT 1');
    expect(conn.log).toEqual([expect.stringContaining('@@collation_database'), 'SELECT 1']);
  });
  it('探查失败 → 静默跳过不阻断', async () => {
    const conn = fakeConn([() => { throw new Error('no priv'); }, [{ affectedRows: 1 }]]);
    const s = createMysqlSession(conn, 30_000);
    const r = await s.exec('SELECT 1');
    expect(r.affectedRows).toBe(1);
    expect(conn.log[1]).toBe('SELECT 1');
  });
  it('对齐只做一次（后续 exec 不再探查）', async () => {
    const conn = fakeConn([
      [{ cs: 'utf8mb4', dbColl: 'utf8mb4_0900_ai_ci', connColl: 'utf8mb4_unicode_ci' }],
      { affectedRows: 0 },
    ]);
    const s = createMysqlSession(conn, 30_000);
    await s.exec('SELECT 1');
    const callsAfterFirst = conn.log.length;
    await s.exec('SELECT 2');
    expect(conn.log.length).toBe(callsAfterFirst + 1);
    expect(conn.log.at(-1)).toBe('SELECT 2');
  });
});
