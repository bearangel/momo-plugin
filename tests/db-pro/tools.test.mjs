import { describe, it, expect, vi } from 'vitest';
import fmt from '../../plugins/db-pro/engine/format.js';
const { formatTable } = fmt;
import toolsMod from '../../plugins/db-pro/tools/index.js';
const { createTools } = toolsMod;

describe('formatTable', () => {
  it('表头 + 行 + 注脚；长单元格截断', () => {
    const out = formatTable(['id', 'name'], [[1, 'x'.repeat(80)], [2, 'b']], '2 行');
    const lines = out.split('\n');
    expect(lines[0]).toContain('id');
    expect(lines[1]).toContain('---');
    expect(out).not.toContain('x'.repeat(60)); // 48 字符截断
    expect(out.endsWith('2 行')).toBe(true);
  });
  it('空结果集容忍', () => {
    expect(formatTable(['a'], [], null)).toContain('a');
  });
});

describe('createTools', () => {
  function mk() {
    const callService = vi.fn(async (method) => {
      if (method === 'query') return { columns: ['a'], rows: [[1], [2]], total: 2, truncated: false };
      if (method === 'write') return { requestId: 'rq-1', status: 'pending' };
      if (method === 'writeStatus') return { status: 'executed', affectedRows: 3 };
      if (method === 'listConnections') return { connections: [{ name: 'conn1', dialect: 'mysql' }] };
      return { schemas: ['public'] };
    });
    const tools = createTools({ callService, logger: { info: () => {}, warn: () => {} } });
    const toolCtx = { streamSessionId: 'sess-x', taskId: 'task-y' };
    return { tools, callService, toolCtx };
  }

  it('11 个工具定义 + 短名合法（宿主 SHORT_NAME_RE）+ 宿主契约字段 inputSchema', () => {
    const { tools } = mk();
    const defs = tools.getDefs();
    expect(defs).toHaveLength(11);
    for (const d of defs) {
      expect(d.name).toMatch(/^[a-z][a-z0-9_]*$/);
      // 宿主 LLMToolDef 契约：inputSchema（非 OpenAI 风格 parameters）——
      // 用错字段名会让 token 估算层拿到 undefined（验收 P0 实证）
      expect(d.inputSchema).toEqual(expect.objectContaining({ type: 'object' }));
      expect(d.inputSchema.properties).toBeDefined();
      expect(d.inputSchema.required).toBeInstanceOf(Array);
    }
    expect(defs.map((d) => d.name)).toEqual(expect.arrayContaining(['query', 'write', 'write_status']));
  });

  it('query：callService 注入 sessionId/taskId（Review Focus #4）+ 表格渲染', async () => {
    const { tools, callService, toolCtx } = mk();
    const out = await tools.execute('query', { sql: 'SELECT 1' }, toolCtx);
    expect(callService).toHaveBeenCalledWith('query',
      expect.objectContaining({ sql: 'SELECT 1', sessionId: 'sess-x', taskId: 'task-y' }),
      { timeoutMs: 60000 });
    expect(out).toContain('a');
    expect(out).toContain('1');
  });

  it('write：渲染 pending 指引（不谎称已执行）', async () => {
    const { tools, toolCtx } = mk();
    const out = await tools.execute('write', { connection: 'c', sql: 'UPDATE t SET a=1' }, toolCtx);
    expect(out).toContain('rq-1');
    expect(out).toContain('批准');
  });

  it('write_status：executed 渲染影响行数；未知工具拒绝', async () => {
    const { tools, toolCtx } = mk();
    const out = await tools.execute('write_status', { requestId: 'r' }, toolCtx);
    expect(out).toContain('3');
    await expect(tools.execute('bogus', {}, toolCtx)).rejects.toThrow(/未知工具/);
  });
});
