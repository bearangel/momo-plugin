// tests/db-pro/script-splitter.test.mjs
// 脚本切分器测试（spec 2026-11-19 §5.2）——按 profile 逐任务追加。
import { describe, it, expect } from 'vitest';
import m from '../../plugins/db-pro/engine/script-splitter.js';
const { splitStatements, SplitterError } = m;

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
