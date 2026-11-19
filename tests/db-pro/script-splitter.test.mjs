// tests/db-pro/script-splitter.test.mjs
// 脚本切分器测试（spec 2026-11-19 §5.2）——按 profile 逐任务追加。
import { describe, it, expect } from 'vitest';
import m from '../../plugins/db-pro/engine/script-splitter.js';
const { splitStatements, SplitterError } = m;
import { classifyStatement, summarize, extractScriptNo } from '../../plugins/db-pro/engine/script-splitter.js';

describe('splitStatements · 基础切分', () => {
  it('两条语句按分号切分，行号/首词正确', () => {
    const r = splitStatements('SELECT 1;\nSELECT 2;', 'mysql');
    expect(r.statements.map((s) => s.text)).toEqual(['SELECT 1', 'SELECT 2']);
    expect(r.statements.map((s) => s.line)).toEqual([1, 2]);
    expect(r.statements.map((s) => s.keyword)).toEqual(['select', 'select']);
    expect(r.statements.map((s) => s.idx)).toEqual([1, 2]);
  });
  it('字符串与注释里的分号不切分', () => {
    const r = splitStatements("SELECT 'a;b', 2 -- x;y\n;", 'mysql');
    expect(r.statements).toHaveLength(1);
    expect(r.statements[0].text).toContain("'a;b'");
  });
  it('块注释跨行 + 尾语句无分号容忍', () => {
    const r = splitStatements('/* a;\nb */ SELECT 1', 'mysql');
    expect(r.statements.map((s) => s.text)).toEqual(['SELECT 1']);
  });
  it('未闭合单引号 → SplitterError 带行号', () => {
    try {
      splitStatements("SELECT 'oops", 'mysql');
      expect.unreachable('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(SplitterError);
      expect(err.line).toBe(1);
      expect(err.message).toContain('未闭合');
    }
  });
  it('空脚本 / 纯注释 → 0 条语句', () => {
    expect(splitStatements('', 'mysql').statements).toEqual([]);
    expect(splitStatements('-- hi\n/* x */', 'mysql').statements).toEqual([]);
  });
  it('未知方言拒绝', () => {
    expect(() => splitStatements('SELECT 1', 'sqlite')).toThrow(/不支持的脚本方言/);
  });
});

describe('splitStatements · MySQL DELIMITER', () => {
  it('过程体内的分号不切分，DELIMITER 切到 // 后再切回 ;', () => {
    const script = [
      "SET @__script_no = 'S00971511';",
      'DELIMITER //',
      'CREATE PROCEDURE p_demo()',
      'BEGIN',
      '  INSERT INTO t VALUES (1);',
      '  INSERT INTO t VALUES (2);',
      'END //',
      'DELIMITER ;',
      'CALL p_demo();',
    ].join('\n');
    const r = splitStatements(script, 'mysql');
    expect(r.statements).toHaveLength(3);
    expect(r.statements[0].keyword).toBe('set');
    expect(r.statements[1].keyword).toBe('create');
    expect(r.statements[1].text).toContain('INSERT INTO t VALUES (2);');
    expect(r.statements[1].text.trim().endsWith('END')).toBe(true);
    expect(r.statements[2].keyword).toBe('call');
    expect(r.statements[1].line).toBe(3);
  });
  it('DELIMITER 行本身不产出语句', () => {
    const r = splitStatements('DELIMITER //\nSELECT 1//\nDELIMITER ;\nSELECT 2;', 'mysql');
    expect(r.statements.map((s) => s.text)).toEqual(['SELECT 1', 'SELECT 2']);
  });
});

describe('splitStatements · PostgreSQL profile', () => {
  it('CREATE FUNCTION $$ 体内分号不切分', () => {
    const script = [
      'CREATE FUNCTION f_demo() RETURNS void AS $$',
      'BEGIN',
      '  INSERT INTO t VALUES (1);',
      'END;',
      '$$ LANGUAGE plpgsql;',
      'SELECT f_demo();',
    ].join('\n');
    const r = splitStatements(script, 'postgres');
    expect(r.statements).toHaveLength(2);
    expect(r.statements[0].keyword).toBe('create');
    expect(r.statements[1].keyword).toBe('select');
  });
  it('带标签的美元引用 $body$ 正常闭合', () => {
    const r = splitStatements('DO $body$ BEGIN PERFORM 1; END $body$;\nSELECT 1;', 'postgresql');
    expect(r.statements).toHaveLength(2);
  });
  it('行首反斜杠元命令 → 明确拒绝', () => {
    expect(() => splitStatements('\\i /tmp/a.sql\nSELECT 1;', 'postgres'))
      .toThrow(/psql 元命令/);
  });
  it('未闭合美元引用 → 报错', () => {
    expect(() => splitStatements('CREATE FUNCTION f() AS $$ BEGIN RETURN;', 'postgres'))
      .toThrow(/美元引用/);
  });
});

describe('splitStatements · Oracle/DM profile', () => {
  const oracleScript = [
    'SET SERVEROUTPUT ON',
    'CREATE OR REPLACE PROCEDURE p_demo AS',
    '  v NUMBER := 0;',
    'BEGIN',
    '  IF v = 0 THEN',
    '    INSERT INTO t VALUES (1);',
    '  ELSE',
    '    LOOP',
    '      v := v + 1;',
    '      EXIT WHEN v > 2;',
    '    END LOOP;',
    '  END IF;',
    'END;',
    '/',
    'EXEC p_demo',
    'COMMIT;',
  ].join('\n');

  it('过程体内分号不切分；独行 / 终结；EXEC 包装；SET 指令过滤并警告', () => {
    const r = splitStatements(oracleScript, 'oracle');
    expect(r.warnings.some((w) => w.type === 'filtered_directive')).toBe(true);
    expect(r.statements.map((s) => s.keyword)).toEqual(['create', 'begin', 'commit']);
    expect(r.statements[0].text).toContain('END LOOP;');
    expect(r.statements[1].text).toMatch(/^BEGIN\s+p_demo\s*;\s*END$/);
  });
  it('匿名块 BEGIN…END; 作为单条语句', () => {
    const r = splitStatements('BEGIN\n  DELETE FROM t;\nEND;\nSELECT 1 FROM dual;', 'dm');
    expect(r.statements).toHaveLength(2);
    expect(r.statements[0].keyword).toBe('begin');
  });
  it('字符串里的 END; 不干扰深度', () => {
    const r = splitStatements("BEGIN\n  INSERT INTO t VALUES ('END;');\nEND;\nSELECT 1 FROM dual;", 'oracle');
    expect(r.statements).toHaveLength(2);
  });
  it('控制流指令拒绝（EXIT / WHENEVER / @include）', () => {
    expect(() => splitStatements('EXIT\n', 'oracle')).toThrow(/不支持.*EXIT|控制流/);
    expect(() => splitStatements('@a.sql\n', 'dm')).toThrow(/不支持/);
  });
});

describe('classifyStatement / summarize / extractScriptNo', () => {
  it.each([
    ['SELECT * FROM t', 'read'],
    ['INSERT INTO t VALUES (1)', 'insert'],
    ['UPDATE t SET a = 1', 'update'],
    ['DELETE FROM t', 'delete'],
    ['MERGE INTO t USING s ON (1=1)', 'merge'],
    ['TRUNCATE TABLE t', 'ddl_table'],
    ['CREATE TABLE t (id INT)', 'ddl_table'],
    ['DROP TABLE IF EXISTS t', 'ddl_table'],
    ['ALTER TABLE t ADD c INT', 'ddl_table'],
    ['CREATE INDEX ix ON t(a)', 'ddl_other'],
    ['CREATE OR REPLACE VIEW v AS SELECT 1', 'ddl_other'],
    ['CREATE PROCEDURE p() BEGIN END', 'procedure'],
    ['CALL p()', 'procedure'],
    ['SET @x = 1', 'session'],
    ['START TRANSACTION', 'txn'],
    ['COMMIT', 'txn'],
    ['BEGIN DELETE FROM t; END', 'block'],
    ['GRANT SELECT ON t TO u', 'priv'],
  ])('%s → %s', (sql, cls) => {
    expect(classifyStatement(sql).cls).toBe(cls);
  });

  it('表推断去引号/去重', () => {
    const r = classifyStatement('INSERT INTO `db`.`t` SELECT * FROM t');
    expect(r.tables).toContain('t');
  });

  it('summarize 计数与表并集', () => {
    const r = splitStatements('INSERT INTO a VALUES (1);\nUPDATE b SET x=1;\nSELECT 1;', 'mysql');
    const s = summarize(r.statements);
    expect(s.statementCount).toBe(3);
    expect(s.counts).toEqual({ insert: 1, update: 1, read: 1 });
    expect(s.tables).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('extractScriptNo 从 @__script_no 与注释兜底', () => {
    expect(extractScriptNo("SET @__script_no = 'S00971511';")).toBe('S00971511');
    expect(extractScriptNo('-- SCRIPT_NO: S00957558')).toBe('S00957558');
    expect(extractScriptNo('SELECT 1')).toBeNull();
  });
});
