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
      if (method === 'writeStatus') return { status: 'executed', affectedRows: 3, opClass: 'DML' };
      if (method === 'listConnections') return { connections: [{ name: 'conn1', dialect: 'mysql' }] };
      return { schemas: ['public'] };
    });
    const tools = createTools({ callService, logger: { info: () => {}, warn: () => {} } });
    // sessionId 取 roomId（human_requests.session_id 外键 = sessions.id = 房间 ID；
    // streamSessionId 是流 ID，非 sessions 行——写批准面板按房间挂载）
    const toolCtx = { roomId: 'room-1', streamSessionId: 'stream-x', taskId: 'task-y' };
    return { tools, callService, toolCtx };
  }

  it('14 个工具定义 + 短名合法（宿主 SHORT_NAME_RE）+ 宿主契约字段 inputSchema', () => {
    const { tools } = mk();
    const defs = tools.getDefs();
    expect(defs).toHaveLength(14);
    for (const d of defs) {
      expect(d.name).toMatch(/^[a-z][a-z0-9_]*$/);
      // 宿主 LLMToolDef 契约：inputSchema（非 OpenAI 风格 parameters）——
      // 用错字段名会让 token 估算层拿到 undefined（验收 P0 实证）
      expect(d.inputSchema).toEqual(expect.objectContaining({ type: 'object' }));
      expect(d.inputSchema.properties).toBeDefined();
      expect(d.inputSchema.required).toBeInstanceOf(Array);
    }
    expect(defs.map((d) => d.name)).toEqual(expect.arrayContaining(['query', 'write', 'write_status', 'script_execute', 'script_status', 'script_history']));
  });

  it('query：callService 注入 sessionId/taskId（Review Focus #4）+ 表格渲染', async () => {
    const { tools, callService, toolCtx } = mk();
    const out = await tools.execute('query', { sql: 'SELECT 1' }, toolCtx);
    expect(callService).toHaveBeenCalledWith('query',
      expect.objectContaining({ sql: 'SELECT 1', sessionId: 'room-1', taskId: 'task-y' }),
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

  it('write_status：executed 渲染影响行数；DDL 0 行/ DML 0 行分语义文案；未知工具拒绝', async () => {
    const { tools, toolCtx } = mk();
    const out = await tools.execute('write_status', { requestId: 'r' }, toolCtx);
    expect(out).toContain('3');
    await expect(tools.execute('bogus', {}, toolCtx)).rejects.toThrow(/未知工具/);
  });
});

// 文案语义修复（2026-11-18 用户实测）：DDL affectedRows=0 被 agent 误读为失败
// 反复补发——按 opClass 区分「结构变更无行影响」与「DML 无匹配行」。
describe('write_status 文案语义', () => {
  const mkStatus = (res) => {
    const callService = vi.fn(async () => res);
    return createTools({ callService, logger: { info: () => {}, warn: () => {} } });
  };
  it('DDL 0 行 → 「结构变更成功（不产生行影响）」', async () => {
    const t = mkStatus({ status: 'executed', affectedRows: 0, opClass: 'DDL' });
    const out = await t.execute('write_status', { requestId: 'r' }, { roomId: 'x', taskId: null });
    expect(out).toContain('结构变更不产生行影响');
    expect(out).not.toMatch(/影响行数: 0/);
  });
  it('DML 0 行 → 提示无匹配行（可能目标已满足）', async () => {
    const t = mkStatus({ status: 'executed', affectedRows: 0, opClass: 'DML' });
    const out = await t.execute('write_status', { requestId: 'r' }, { roomId: 'x', taskId: null });
    expect(out).toContain('无匹配行');
  });
});

// 脚本三工具（spec 2026-11-19 §5.6）：透传映射 + 渲染文案。
describe('script_* 工具', () => {
  function fakeCtx() {
    const calls = [];
    return {
      calls,
      callService: async (method, params) => {
        calls.push({ method, params });
        if (method === 'scriptExecute') return { requestId: 'r1', status: 'pending', scriptNo: 'S1', summary: { statementCount: 2 } };
        if (method === 'scriptStatus') return { status: 'executed', result: { ok: true, total: 2, executed: 2, durationMs: 3 } };
        return { entries: [] };
      },
    };
  }

  it('script_execute 透传并注入 sessionId/taskId，渲染待批准文案', async () => {
    const ctx = fakeCtx();
    const tools = createTools(ctx);
    const text = await tools.execute('script_execute', { connection: 'c', script: 'X', on_error: 'continue' }, { roomId: 'room1', taskId: 't1' });
    expect(ctx.calls[0].method).toBe('scriptExecute');
    expect(ctx.calls[0].params).toMatchObject({ connection: 'c', script: 'X', onError: 'continue', sessionId: 'room1', taskId: 't1' });
    expect(text).toContain('等待用户批准');
  });

  it('script_status executed → 返回执行摘要', async () => {
    const tools = createTools(fakeCtx());
    const text = await tools.execute('script_status', { requestId: 'r1' }, { roomId: 'room1' });
    expect(text).toContain('已执行');
  });

  it('category 前缀与 defaultOn 缺省', () => {
    const catalog = createTools(fakeCtx()).getCatalog();
    const item = catalog.find((c) => c.name === 'script_execute');
    expect(item.category).toBe('插件 db-pro');
    expect(item.defaultOn).toBe(false);
  });
});

// 无缺省连接概念（2026-11-19 用户裁定）：所有库操作工具 connection 必填。
describe('connection 必填契约', () => {
  it('全部数据库操作工具 required 含 connection', () => {
    const defs = createTools({ callService: async () => ({}) }).getDefs();
    const need = ['query', 'list_schemas', 'list_tables', 'list_views', 'describe_table', 'list_columns', 'get_ddl', 'explain_query', 'write', 'script_execute'];
    for (const name of need) {
      const d = defs.find((x) => x.name === name);
      expect(d.inputSchema.required).toContain('connection');
      expect(d.inputSchema.properties.connection.description).not.toContain('缺省');
    }
  });
  it('list_connections 渲染包含描述（用途说明）', async () => {
    const tools = createTools({
      callService: async () => ({ connections: [{ name: 'mysql_dev', dialect: 'mysql', description: '开发库 · 只读', ok: true }] }),
    });
    const text = await tools.execute('list_connections', {}, { roomId: 'r' });
    expect(text).toContain('开发库 · 只读');
  });
});

// C 期回执（spec 2026-11-20 §8.4）：语句/业务结果分离 + 逐条明细 + 核验 + 预检分级
describe('tools · C 期回执与描述', () => {
  function mkScriptTools(statusRes, execRes) {
    const callService = vi.fn(async (method) => {
      if (method === 'scriptStatus') return statusRes;
      if (method === 'scriptExecute') return execRes;
      return {};
    });
    const tools = createTools({ callService, logger: { info: () => {}, warn: () => {} } });
    return { tools, callService };
  }

  it('script_status executed：摘要行区分语句/业务 + 逐条明细 + 核验', async () => {
    const { tools } = mkScriptTools({ status: 'executed', result: {
      ok: true, total: 8, executed: 8, durationMs: 1200,
      businessStatus: 'failed', businessSource: 'layer1_marker',
      businessError: '[FAIL] S00971511 -- [23000] Duplicate entry',
      results: [{ idx: 3, line: 10, kind: 'call', status: 'ok', affectedRows: 0, durationMs: 500,
        outputs: [{ columns: ['execution_status'], rows: [['[FAIL] S00971511 -- [23000] Duplicate entry']] }] }],
      verification: [{ table: 'DAP_E_MCP_TOOL', before: 18, after: 23, delta: 5 }],
    } });
    const text = await tools.execute('script_status', { requestId: 'r1' }, { roomId: 'room1' });
    expect(text).toContain('语句 8/8 成功');
    expect(text).toContain('业务结果：失败');
    expect(text).toContain('[23000]');
    expect(text).toContain('#3');
    expect(text).toContain('call');
    expect(text).toContain('DAP_E_MCP_TOOL: +5 (18→23)');
    expect(text).toContain('参考值');
  });

  it('script_status executed 业务成功（层2）', async () => {
    const { tools } = mkScriptTools({ status: 'executed', result: {
      ok: true, total: 8, executed: 8, durationMs: 100,
      businessStatus: 'ok', businessSource: 'layer2_logtable', results: [], verification: [] } });
    const text = await tools.execute('script_status', { requestId: 'r1' }, { roomId: 'room1' });
    expect(text).toContain('业务结果：成功');
    expect(text).toContain('日志表');
  });

  it('dryrun 回执呈现 precheck 分级项', async () => {
    const { tools } = mkScriptTools(null, { dryrun: true, statements: [
      { idx: 1, line: 1, cls: 'insert', keyword: 'insert', tables: ['t'] }],
      summary: { statementCount: 1, counts: {}, tables: [] }, scriptNo: 'S1',
      precheck: { ran: true, supported: true, items: [
        { level: 'high', code: 'uk_conflict', message: 't 与已存在记录冲突' },
        { level: 'warn', code: 'collation_mismatch', message: '表 t collation 不一致' },
      ] } });
    const text = await tools.execute('script_execute', { connection: 'c', script: 'X', dryrun: true }, { roomId: 'room1' });
    expect(text).toContain('high');
    expect(text).toContain('t 与已存在记录冲突');
    expect(text).toContain('预检');
  });

  it('工具描述含业务判定与预检说明', async () => {
    const { tools } = mkScriptTools(null, null);
    const defs = tools.getDefs();
    const se = defs.find((d) => d.name === 'script_execute');
    expect(se.description).toContain('业务');
    expect(se.description).toContain('预检');
    const ss = defs.find((d) => d.name === 'script_status');
    expect(ss.description).toContain('业务');
  });
});
