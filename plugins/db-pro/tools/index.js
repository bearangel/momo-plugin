'use strict';
// db-pro 工具面（spec §4.1，11 工具）：薄壳——定义 + callService 透传 + 结果渲染。
// 行为边界写入工具描述（防 LLM 误用）；write 注入 sessionId=toolCtx.roomId /
// taskId（人工请求按房间挂载——human_requests.session_id 外键 = sessions.id）。
const { formatTable } = require('../engine/format');

const CALL_TIMEOUT_MS = 60_000; // 桥上限（spec §2 事实 1）

const DEFS = [
  {
    name: 'list_connections',
    description: '列出已配置的数据库连接（名称 + 类型，不含凭据）。查询前先调用此工具确认可用连接。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_schemas',
    description: '列出指定数据库的 schema 清单。',
    inputSchema: {
      type: 'object',
      properties: { connection: { type: 'string', description: '连接名（省略用缺省连接）' } },
      required: [],
    },
  },
  {
    name: 'list_tables',
    description: '列出表清单（含视图，type 区分）。',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: '连接名（省略用缺省连接）' },
        schema: { type: 'string', description: 'schema（省略用连接缺省）' },
      },
      required: [],
    },
  },
  {
    name: 'list_views',
    description: '列出视图清单。',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: '连接名（省略用缺省连接）' },
        schema: { type: 'string', description: 'schema（省略用连接缺省）' },
      },
      required: [],
    },
  },
  {
    name: 'describe_table',
    description: '表结构概要：列 / 索引 / 行数估算。',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: '连接名（省略用缺省连接）' },
        schema: { type: 'string', description: 'schema（省略用连接缺省）' },
        table: { type: 'string', description: '表名' },
      },
      required: ['table'],
    },
  },
  {
    name: 'list_columns',
    description: '列明细（名称/类型/可空/默认值/注释）。',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: '连接名（省略用缺省连接）' },
        schema: { type: 'string', description: 'schema（省略用连接缺省）' },
        table: { type: 'string', description: '表名' },
      },
      required: ['table'],
    },
  },
  {
    name: 'get_ddl',
    description: '建表 DDL（MySQL=SHOW CREATE；Oracle/达梦=DBMS_METADATA；PG=catalog 拼装）。',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: '连接名（省略用缺省连接）' },
        schema: { type: 'string', description: 'schema（省略用连接缺省）' },
        table: { type: 'string', description: '表名' },
      },
      required: ['table'],
    },
  },
  {
    name: 'query',
    description: '只读 SQL 查询。仅允许 SELECT / SHOW / DESCRIBE / EXPLAIN / WITH(主语句为 SELECT)；禁止多语句与 FOR UPDATE。默认行数上限 200、超时 30s。写操作必须用 write 工具。',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: '连接名（省略用缺省连接）' },
        sql: { type: 'string', description: '只读 SQL 语句（单条）' },
        max_rows: { type: 'number', description: '本次返回行数上限（省略用全局配置，默认 200）' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'explain_query',
    description: '查看执行计划（达梦经 lastExecInfo 特化解析）。',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: '连接名（省略用缺省连接）' },
        sql: { type: 'string', description: '要分析的 SELECT 语句' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'write',
    description: '发起写操作（INSERT/UPDATE/DELETE/MERGE=DML；CREATE/DROP/ALTER/TRUNCATE=DDL）。不直接执行——创建人工批准请求，须提醒用户在「人工请求」面板批准/拒绝，随后用 write_status 查询结果。批准前不得声称已执行。',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: '连接名（必填）' },
        sql: { type: 'string', description: '单条写语句' },
      },
      required: ['connection', 'sql'],
    },
  },
  {
    name: 'write_status',
    description: '查询写请求的人工批准状态。approved 时此刻执行并返回影响行数（同一请求只执行一次）；denied 返回拒绝理由；pending 表示仍在等待。',
    inputSchema: {
      type: 'object',
      properties: { requestId: { type: 'string', description: 'write 返回的请求 ID' } },
      required: ['requestId'],
    },
  },
];

const METHOD_OF = {
  list_connections: 'listConnections',
  list_schemas: 'meta.listSchemas',
  list_tables: 'meta.listTables',
  list_views: 'meta.listViews',
  describe_table: 'meta.describe',
  list_columns: 'meta.columns',
  get_ddl: 'meta.ddl',
  query: 'query',
  explain_query: 'explain',
  write: 'write',
  write_status: 'writeStatus',
};

function render(name, res) {
  if (name === 'query') {
    const note = res.truncated
      ? `…（共 ${res.total} 行，已截断至 ${res.rows.length} 行——可用 WHERE/LIMIT 缩小）`
      : `${res.rows.length} 行`;
    return formatTable(res.columns, res.rows, note);
  }
  if (name === 'explain_query') {
    return `${res.text}${res.summary ? `\n摘要: ${res.summary}` : ''}`;
  }
  if (name === 'write') {
    return `写请求已创建（requestId: ${res.requestId}），等待用户在「人工请求」面板批准。请提醒用户处理，随后调用 write_status 查询结果——批准前不会执行任何写操作。`;
  }
  if (name === 'write_status') {
    if (res.status === 'executed') {
      return `已执行${res.replayed ? '（此前已执行，本次返回缓存结果）' : ''}，影响行数: ${res.affectedRows}`;
    }
    if (res.status === 'denied') {
      return `用户拒绝了该写请求。${res.note ? `附言：${res.note}` : ''}`;
    }
    if (res.status === 'pending') return '仍在等待用户批准。';
    return `请求状态: ${res.status}${res.note ? `（${res.note}）` : ''}`;
  }
  if (name === 'list_connections') {
    return res.connections.length === 0
      ? '（未配置连接——请在 设置 → 插件 → db-pro 配置连接串）'
      : res.connections.map((c) => {
          if (c.ok === false) return `- ${c.name}（${c.dialect}，⚠ 配置失败：${c.reason}）`;
          return `- ${c.name}（${c.dialect}）`;
        }).join('\n');
  }
  if (name === 'get_ddl') return res.ddl;
  return JSON.stringify(res, null, 2);
}

function createTools(ctx) {
  return {
    getDefs: () => DEFS.map((d) => ({ ...d })),
    getCatalog: () => DEFS.map((d) => ({
      name: d.name,
      displayName: d.name,
      description: d.description,
      category: '插件 db-pro',
      categoryEmoji: '',
      defaultOn: false,
    })),
    handles: () => true,
    execute: async (name, args, toolCtx) => {
      const method = METHOD_OF[name];
      if (!method) throw new Error(`未知工具: ${name}`);
      // sessionId 用 roomId：human_requests.session_id 外键指向 sessions.id（房间），
      // 人工请求面板也按房间挂载——streamSessionId 是流 ID 非 sessions 行（验收 P0 实证）
      const mapped = { ...args };
      if (mapped.max_rows !== undefined) mapped.maxRows = mapped.max_rows; // M-C：spec 命名 → service 契约
      const res = await ctx.callService(
        method,
        { ...mapped, sessionId: toolCtx.roomId, taskId: toolCtx.taskId ?? null },
        { timeoutMs: CALL_TIMEOUT_MS },
      );
      return render(name, res);
    },
  };
}

module.exports = { createTools };
