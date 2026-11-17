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
