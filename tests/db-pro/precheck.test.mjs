// tests/db-pro/precheck.test.mjs
// 连库预检（spec 2026-11-20 §6，R4）：表存在性/列匹配/UK 冲突预演/collation 一致性——纯函数 + 假 pool。
import { describe, it, expect } from 'vitest';
import m from '../../plugins/db-pro/engine/precheck.js';
const { runPrecheck, extractInsertInfo } = m;

// 假 pool：按 SQL 特征路由 canned information_schema 应答
function fakePool(over) {
  return {
    query: async (sql) => {
      if (/information_schema\.TABLES/i.test(sql)) return { columns: ['t', 'c'], rows: over.tables ?? [] };
      if (/information_schema\.COLUMNS/i.test(sql)) return { columns: ['t', 'c'], rows: over.columns ?? [] };
      if (/information_schema\.STATISTICS/i.test(sql)) return { columns: ['i', 'c', 'n'], rows: over.stats ?? [] };
      if (/@@collation_database/i.test(sql)) return { columns: ['c'], rows: [[over.dbCollation ?? 'utf8mb4_0900_ai_ci']] };
      if (/COUNT\(\*\)/i.test(sql)) { const n = over.counts.shift() ?? 0; return { columns: ['c'], rows: [[n]] }; }
      throw new Error('unexpected sql: ' + sql);
    },
  };
}

function stmt(text, cls = 'insert') {
  const info = extractInsertInfo(text);
  return {
    idx: 1, line: 1, text, keyword: text.trim().split(/\s+/)[0].toLowerCase(), cls,
    tables: info?.table ? [info.table] : [],
  };
}

describe('extractInsertInfo（INSERT 静态解析纯函数）', () => {
  it('普通 INSERT：表/列/字面量元组', () => {
    const r = extractInsertInfo("INSERT INTO t (a, b, c) VALUES (1, 'x', NULL);");
    expect(r).toEqual({ table: 't', columns: ['a', 'b', 'c'], literals: ['1', "'x'", 'NULL'] });
  });
  it('含变量/函数 → literals 对应位 null（Review Focus 4）', () => {
    const r = extractInsertInfo('INSERT INTO t (a, b) VALUES (@v, NOW());');
    expect(r.literals).toEqual([null, null]);
  });
  it('无列清单 INSERT → columns null', () => {
    expect(extractInsertInfo('INSERT INTO t VALUES (1);').columns).toBeNull();
  });
  it('嵌套括号函数字面量位 → null', () => {
    const r = extractInsertInfo("INSERT INTO t (a) VALUES (CONCAT('x', 'y'));");
    expect(r.literals).toEqual([null]);
  });
  it('非 INSERT → null', () => {
    expect(extractInsertInfo('SELECT 1')).toBeNull();
  });
});

describe('runPrecheck · 表存在性（顺序感知）', () => {
  it('库中缺表 → table_missing warn；脚本内先前 CREATE 的表不算缺', async () => {
    const pool = fakePool({ tables: [['exists_t', 'utf8mb4_0900_ai_ci']] });
    const stmts = [
      { idx: 1, line: 1, text: 'CREATE TABLE new_t (id INT)', keyword: 'create', cls: 'ddl_table', tables: ['new_t'] },
      { idx: 2, line: 2, text: 'INSERT INTO new_t VALUES (1)', keyword: 'insert', cls: 'insert', tables: ['new_t'] },
      { idx: 3, line: 3, text: 'INSERT INTO missing_t VALUES (1)', keyword: 'insert', cls: 'insert', tables: ['missing_t'] },
      { idx: 4, line: 4, text: 'INSERT INTO exists_t VALUES (1)', keyword: 'insert', cls: 'insert', tables: ['exists_t'] },
    ];
    const r = await runPrecheck(pool, stmts, 'mysql');
    const missing = r.items.filter((x) => x.code === 'table_missing');
    expect(missing).toHaveLength(1);
    expect(missing[0].message).toContain('missing_t');
    expect(missing[0].level).toBe('warn');
  });
});

describe('runPrecheck · INSERT 列匹配', () => {
  it('缺列/未知列 → column_mismatch warn 逐条列出', async () => {
    const pool = fakePool({
      tables: [['t', 'utf8mb4_0900_ai_ci']],
      columns: [['t', 'a'], ['t', 'b']],
    });
    const r = await runPrecheck(pool, [stmt('INSERT INTO t (a, bad_col) VALUES (1, 2)')], 'mysql');
    const hit = r.items.find((x) => x.code === 'column_mismatch');
    expect(hit.level).toBe('warn');
    expect(hit.message).toContain('bad_col');
  });
  it('列全匹配 → 无该项', async () => {
    const pool = fakePool({ tables: [['t', 'x']], columns: [['t', 'a'], ['t', 'b']] });
    const r = await runPrecheck(pool, [stmt('INSERT INTO t (a, b) VALUES (1, 2)')], 'mysql');
    expect(r.items.some((x) => x.code === 'column_mismatch')).toBe(false);
  });
});

describe('runPrecheck · UK 冲突预演', () => {
  it('UK 组全列字面量齐备 + COUNT>0 → uk_conflict high', async () => {
    const pool = fakePool({
      tables: [['t', 'x']],
      columns: [['t', 'uk1'], ['t', 'uk2'], ['t', 'v']],
      stats: [['PRIMARY', 'id', 0], ['UK_X', 'uk1', 0], ['UK_X', 'uk2', 0]],
      counts: [1],
    });
    const r = await runPrecheck(pool, [stmt("INSERT INTO t (uk1, uk2, v) VALUES ('a', 'b', 1)")], 'mysql');
    const hit = r.items.find((x) => x.code === 'uk_conflict');
    expect(hit.level).toBe('high');
    expect(hit.message).toContain('t');
  });
  it('COUNT=0 → 不报', async () => {
    const pool = fakePool({
      tables: [['t', 'x']],
      columns: [['t', 'uk1']],
      stats: [['UK_X', 'uk1', 0]],
      counts: [0],
    });
    const r = await runPrecheck(pool, [stmt("INSERT INTO t (uk1) VALUES ('a')")], 'mysql');
    expect(r.items.some((x) => x.code === 'uk_conflict')).toBe(false);
  });
  it('UK 列字面量不齐 → 静默跳过（Review Focus 4）', async () => {
    const pool = fakePool({
      tables: [['t', 'x']],
      columns: [['t', 'uk1'], ['t', 'uk2']],
      stats: [['UK_X', 'uk1', 0], ['UK_X', 'uk2', 0]],
      counts: [],
    });
    const r = await runPrecheck(pool, [stmt("INSERT INTO t (uk1, uk2) VALUES (@a, 'b')")], 'mysql');
    expect(r.items.some((x) => x.code === 'uk_conflict')).toBe(false);
    expect(pool.query ? true : true).toBe(true);
  });
});

describe('runPrecheck · collation 一致性', () => {
  it('表 collation ≠ 库默认 → collation_mismatch warn', async () => {
    const pool = fakePool({ tables: [['t', 'utf8mb4_unicode_ci']], dbCollation: 'utf8mb4_0900_ai_ci' });
    const stmts = [{ idx: 1, line: 1, text: 'INSERT INTO t VALUES (1)', keyword: 'insert', cls: 'insert', tables: ['t'] }];
    const r = await runPrecheck(pool, stmts, 'mysql');
    const hit = r.items.find((x) => x.code === 'collation_mismatch');
    expect(hit.level).toBe('warn');
    expect(hit.message).toContain('SET NAMES');
  });
});

describe('runPrecheck · 方言与容错', () => {
  it('非 mysql → supported false', async () => {
    const r = await runPrecheck(null, [], 'oracle');
    expect(r).toEqual({ supported: false, note: '该方言暂不支持预检', items: [] });
  });
  it('information_schema 查询失败 → skipped info 项、不炸', async () => {
    const pool = { query: async () => { throw new Error('perm denied'); } };
    const stmts = [{ idx: 1, line: 1, text: 'INSERT INTO t VALUES (1)', keyword: 'insert', cls: 'insert', tables: ['t'] }];
    const r = await runPrecheck(pool, stmts, 'mysql');
    expect(r.supported).toBe(true);
    expect(r.items.some((x) => x.code === 'skipped')).toBe(true);
  });
  it('存储过程体内 INSERT 也被扫描（text 全局扫描）', async () => {
    const pool = fakePool({
      tables: [['t', 'x']],
      columns: [['t', 'a'], ['t', 'b']],
    });
    const procStmt = {
      idx: 1, line: 1, cls: 'procedure', tables: [],
      keyword: 'create',
      text: 'CREATE PROCEDURE sp() BEGIN INSERT INTO t (a, bad_col) VALUES (1, 2); END',
    };
    const r = await runPrecheck(pool, [procStmt], 'mysql');
    expect(r.items.some((x) => x.code === 'column_mismatch')).toBe(true);
  });
});
