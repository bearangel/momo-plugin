import { describe, it, expect } from 'vitest';
import m from '../../plugins/db-pro/engine/drivers/dm.js';
const { parseUrl, parseExplainPlan } = m;

describe('dm parseUrl', () => {
  it('常规形态 + 默认 schema = 用户名大写', () => {
    const c = parseUrl('dm://SYSDBA:SYSDBA@127.0.0.1:15236');
    expect(c).toEqual({
      host: '127.0.0.1', port: 15236, user: 'SYSDBA', password: 'SYSDBA',
      schema: 'SYSDBA', connectString: 'dm://SYSDBA:SYSDBA@127.0.0.1:15236',
    });
  });
  it('显式 schema 段', () => {
    expect(parseUrl('dm://u:p@h:5236/APP').schema).toBe('APP');
  });
  it('dameng:// 别名与 URL 编码密码', () => {
    expect(parseUrl('dameng://u:p%40w@h:5236').password).toBe('p@w');
  });
  it('缺端口默认 5236', () => {
    expect(parseUrl('dm://u:p@h').port).toBe(5236);
  });
  it('输出 connectUrl 可直接作 dmdb connectString（spike 实测形态）', () => {
    const c = parseUrl('dm://SYSDBA:SYSDBA001@127.0.0.1:15236');
    expect(c.connectString).toBe('dm://SYSDBA:SYSDBA001@127.0.0.1:15236');
  });
});

describe('parseExplainPlan（lastExecInfo.explain 文本）', () => {
  it('算子行 #OP 提取 + 首行摘要', () => {
    const text = [
      '1   ##NSET2: [0, 1, 4]',
      '2     #PRJT2: [0, 1, 4]',
      '3       #CSCN2: [0, 100, 4]; INDEX33558972(T)',
    ].join('\n');
    const p = parseExplainPlan(text);
    expect(p.operators).toEqual(['NSET2', 'PRJT2', 'CSCN2']);
    expect(p.summary).toContain('NSET2');
    expect(p.text).toBe(text);
  });
  it('空文本容忍', () => {
    expect(parseExplainPlan('')).toEqual({ text: '', operators: [], summary: '' });
  });
});
