// 只读校验穷举（spec §6.1）：白名单 / 禁多语句 / 拒锁 / 注释与字面量剥离 / 误杀面
import { describe, it, expect } from 'vitest';
import v from '../../plugins/db-pro/engine/sql-validator.js';
const { assertReadOnly, classifyWrite } = v;

describe('assertReadOnly 正例（必须放行）', () => {
  const ok = [
    'SELECT 1',
    "select * from t where name = 'x'",
    "SELECT 'a;b' AS c",
    "SELECT * FROM t WHERE note = 'update soon'",
    'SHOW CREATE TABLE dbpro.t',
    'DESCRIBE t',
    'EXPLAIN SELECT * FROM t',
    'WITH c AS (SELECT 1) SELECT * FROM c',
    'SELECT /* 注释; 含分号 */ 1',
    'SELECT 1 -- 行注释 UPDATE',
    'SELECT "comment" FROM t',                    // 引号标识符走字面量剥离——全文检测后合法列名不受误杀
    'EXPLAIN ANALYZE SELECT * FROM t',            // 合法只读计划（写词扫描扩 explain 后必须仍放行）
    "SELECT 'a;b' AS c, update_flag FROM t2",     // 反引号/字符串外的 update_前缀词无词边界命中
  ];
  for (const sql of ok) it(sql.slice(0, 40), () => expect(assertReadOnly(sql).ok).toBe(true));
});

describe('assertReadOnly 负例（必须拒绝且 reason 人话）', () => {
  const bad = [
    ['UPDATE t SET a = 1', '首词'],
    ['DELETE FROM t', '首词'],
    ['INSERT INTO t VALUES (1)', '首词'],
    ['SELECT * FROM t FOR UPDATE', '锁定子句'],
    ['select 1 for share', '锁定子句'],
    ['SELECT 1; DROP TABLE t', '多语句'],
    ['SELECT 1;SELECT 2', '多语句'],
    ['WITH c AS (SELECT 1) INSERT INTO t SELECT * FROM c', '写关键词'],
    ['WITH del AS (DELETE FROM orders RETURNING *) SELECT * FROM del', 'PG 数据修改 CTE（终审 C1）'],
    ['EXPLAIN ANALYZE DELETE FROM t', 'EXPLAIN ANALYZE 执行写（复审 C-3）'],
    ['EXPLAIN (ANALYZE, BUFFERS) DELETE FROM t', 'EXPLAIN 选项形态执行写（复审 C-3）'],
    ["SELECT 'x' --1 INTO OUTFILE '/tmp/p'", 'MySQL --非空白假注释藏 INTO（复审 I-5）'],
    ['SELECT id, name INTO temp_copy FROM users', 'SELECT INTO 建表（终审 C1）'],
    ["SELECT 1 INTO OUTFILE '/tmp/x'", 'OUTFILE'],
    ['TRUNCATE TABLE t', '首词'],
    ['', 'SQL 为空'],
    ['   ', 'SQL 为空'],
    ['CREATE TABLE t (a int)', '首词'],
  ];
  for (const [sql, why] of bad) it(`${why}：${sql.slice(0, 40) || '(空)'}`, () => {
    const r = assertReadOnly(sql);
    expect(r.ok).toBe(false);
    expect(r.reason.length).toBeGreaterThan(4);
  });
});

describe('classifyWrite', () => {
  it.each([
    ['INSERT INTO t VALUES (1)', 'DML'],
    ['update t set a=1', 'DML'],
    ['DELETE FROM t', 'DML'],
    ['MERGE INTO t USING s ON (1=1)', 'DML'],
    ['CREATE TABLE x (a int)', 'DDL'],
    ['DROP TABLE x', 'DDL'],
    ['ALTER TABLE x ADD c int', 'DDL'],
    ['TRUNCATE TABLE x', 'DDL'],
  ])('%s → %s', (sql, opClass) => expect(classifyWrite(sql).opClass).toBe(opClass));
  it.each([
    ['SELECT 1', 'REJECT'],
    ['GRANT ALL ON t TO u', 'REJECT'],
    ['EXEC pkg.proc', 'REJECT'],
    ['DELETE FROM t; SELECT 1', 'REJECT'],
  ])('%s → %s', (sql, opClass) => expect(classifyWrite(sql).opClass).toBe(opClass));
});
