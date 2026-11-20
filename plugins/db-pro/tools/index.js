'use strict';
// db-pro 工具面（spec §4.1，11 工具）：薄壳——定义 + callService 透传 + 结果渲染。
// 行为边界写入工具描述（防 LLM 误用）；write 注入 sessionId=toolCtx.roomId /
// taskId（人工请求按房间挂载——human_requests.session_id 外键 = sessions.id）。
const { formatTable } = require('../engine/format');

const CALL_TIMEOUT_MS = 60_000; // 桥上限（spec §2 事实 1）

const DEFS = [
  {
    name: 'list_connections',
    description: '列出已配置的数据库连接（名称 / 类型 / 描述，不含凭据）。名称与描述说明该库用途——所有数据库操作都必须显式指定 connection。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_schemas',
    description: '列出指定数据库的 schema 清单。',
    inputSchema: {
      type: 'object',
      properties: { connection: { type: 'string', description: '连接名（必填）' } },
      required: ['connection'],
    },
  },
  {
    name: 'list_tables',
    description: '列出表清单（含视图，type 区分）。',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: '连接名（必填）' },
        schema: { type: 'string', description: 'schema（省略用连接缺省）' },
      },
      required: ['connection'],
    },
  },
  {
    name: 'list_views',
    description: '列出视图清单。',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: '连接名（必填）' },
        schema: { type: 'string', description: 'schema（省略用连接缺省）' },
      },
      required: ['connection'],
    },
  },
  {
    name: 'describe_table',
    description: '表结构概要：列 / 索引 / 行数估算。',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: '连接名（必填）' },
        schema: { type: 'string', description: 'schema（省略用连接缺省）' },
        table: { type: 'string', description: '表名' },
      },
      required: ['connection', 'table'],
    },
  },
  {
    name: 'list_columns',
    description: '列明细（名称/类型/可空/默认值/注释）。',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: '连接名（必填）' },
        schema: { type: 'string', description: 'schema（省略用连接缺省）' },
        table: { type: 'string', description: '表名' },
      },
      required: ['connection', 'table'],
    },
  },
  {
    name: 'get_ddl',
    description: '建表 DDL（MySQL=SHOW CREATE；Oracle/达梦=DBMS_METADATA；PG=catalog 拼装）。',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: '连接名（必填）' },
        schema: { type: 'string', description: 'schema（省略用连接缺省）' },
        table: { type: 'string', description: '表名' },
      },
      required: ['connection', 'table'],
    },
  },
  {
    name: 'query',
    description: '只读 SQL 查询。仅允许 SELECT / SHOW / DESCRIBE / EXPLAIN / WITH(主语句为 SELECT)；禁止多语句与 FOR UPDATE。默认行数上限 200、超时 30s。写操作必须用 write 工具。',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: '连接名（必填）' },
        sql: { type: 'string', description: '只读 SQL 语句（单条）' },
        max_rows: { type: 'number', description: '本次返回行数上限（省略用全局配置，默认 200）' },
      },
      required: ['connection', 'sql'],
    },
  },
  {
    name: 'explain_query',
    description: '查看执行计划（达梦经 lastExecInfo 特化解析）。',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: '连接名（必填）' },
        sql: { type: 'string', description: '要分析的 SELECT 语句' },
      },
      required: ['connection', 'sql'],
    },
  },
  {
    name: 'write',
    description: '发起写操作（INSERT/UPDATE/DELETE/MERGE=DML；CREATE/DROP/ALTER/TRUNCATE=DDL）。不直接执行——创建人工批准请求，用户在「人工请求」面板批准/拒绝后系统会自动唤醒本会话，届时调 write_status 查询结果继续工作。批准前不得声称已执行。',
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
  {
    name: 'script_execute',
    description: '执行 SQL 脚本（多语句，支持 DELIMITER/存储过程/会话变量/事务）。不直接执行——创建脚本级人工批准请求；批准后脚本在后台运行。先调 script_status 轮询结果。回执区分「语句成功」与「业务成功」（业务失败 = 语句全过但脚本内回滚，失败标记输出直接透传）。dryrun:true 做静态分析 + 连库预检（表存在性/列匹配/唯一键冲突预演/collation，分级告警不阻断）。幂等由脚本自身保证，工具不重复判断。',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: '连接名（必填）' },
        script: { type: 'string', description: '脚本全文（≤2MB、≤10000 条语句）' },
        on_error: { type: 'string', enum: ['abort', 'continue'], description: '失败策略（省略 abort=失败即停）' },
        dryrun: { type: 'boolean', description: 'true=只做静态分析并返回语句清单' },
      },
      required: ['connection', 'script'],
    },
  },
  {
    name: 'script_status',
    description: '查询脚本执行状态：pending（待批准）/ denied / running（后台执行中）/ executed（含逐条明细、业务结果与核验摘要）/ exec_unknown（执行中断，勿重跑，先人工核查）/ not_found。业务结果以脚本输出失败标记（如 [FAIL]）为准，语句全成功不代表业务成功。',
    inputSchema: {
      type: 'object',
      properties: { requestId: { type: 'string', description: 'script_execute 返回的请求 ID' } },
      required: ['requestId'],
    },
  },
  {
    name: 'script_history',
    description: '查询脚本执行历史（谁/何时/哪个库/脚本号/结果）。历史仅供参考——是否重复执行由脚本自身幂等逻辑决定。',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: '按连接过滤（省略=全部）' },
        limit: { type: 'number', description: '返回条数（缺省 20，上限 200）' },
      },
      required: [],
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
  script_execute: 'scriptExecute',
  script_status: 'scriptStatus',
  script_history: 'scriptHistory',
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
    return `写请求已创建（requestId: ${res.requestId}），等待用户在「人工请求」面板批准。批准/拒绝后我会被自动唤醒继续——届时调用 write_status 查询结果。批准前不会执行任何写操作。`;
  }
  if (name === 'write_status') {
    if (res.status === 'executed') {
      const once = res.replayed ? '（此前已执行，本次返回缓存结果）' : '';
      // DDL 建表/结构变更 affectedRows=0 是正确语义——按 opClass 分文案，
      // 防 agent 把 0 行误读为失败反复补发（2026-11-18 实证）
      if (res.opClass === 'DDL') return `DDL 已执行成功${once}（结构变更不产生行影响）`;
      if (res.affectedRows === 0) return `已执行${once}，影响行数 0——无匹配行（目标可能已满足条件，请先查询核实再决定是否重发）`;
      return `已执行${once}，影响行数: ${res.affectedRows}`;
    }
    if (res.status === 'denied') {
      return `用户拒绝了该写请求。${res.note ? `附言：${res.note}` : ''}`;
    }
    if (res.status === 'pending') return '仍在等待用户批准。';
    return `请求状态: ${res.status}${res.note ? `（${res.note}）` : ''}`;
  }
  if (name === 'script_execute') {
    if (res.dryrun) {
      const lines = (res.statements ?? []).map((s) => `${s.idx}. [${s.cls}] L${s.line} ${s.keyword}${s.tables?.length ? ` → ${s.tables.join(',')}` : ''}`);
      const head = `静态分析（未执行）：${res.statements?.length ?? 0} 条语句${res.scriptNo ? ` · 脚本号 ${res.scriptNo}` : ''}\n${lines.join('\n')}`;
      const pc = res.precheck;
      if (!pc) return head;
      if (pc.ran === false) return `${head}\n预检跳过：${pc.note ?? '（未知原因）'}——仅静态分析`;
      if (pc.supported === false) return `${head}\n预检：${pc.note ?? '该方言暂不支持预检'}`;
      const pcLines = (pc.items ?? []).map((x) => `[${x.level}] ${x.message}`);
      return `${head}\n预检（连库，分级告警不阻断）${pcLines.length === 0 ? '：无异常项' : `：\n${pcLines.join('\n')}`}`;
    }
    if (res.note) return `脚本${res.note}——未执行。`;
    return `脚本执行请求已创建（requestId: ${res.requestId}，${res.summary?.statementCount ?? '?'} 条语句${res.scriptNo ? ` · 脚本号 ${res.scriptNo}` : ''}），等待用户批准。批准/拒绝后我会被自动唤醒继续——届时调用 script_status 查询结果。批准前不会执行任何语句。`;
  }
  if (name === 'script_status') {
    if (res.status === 'pending') return '仍在等待用户批准脚本执行。';
    if (res.status === 'denied') return `用户拒绝了脚本执行。${res.note ? `附言：${res.note}` : ''}`;
    if (res.status === 'running') return '脚本正在后台执行，请稍候继续轮询。';
    if (res.status === 'exec_unknown') return `执行结果未知（中断）：${res.note ?? ''}请人工核查数据库状态，勿直接重跑。`;
    if (res.status === 'executed') {
      const r = res.result ?? {};
      const once = res.replayed ? '（本次返回缓存结果）' : '';
      // C 期（spec §4.3）：语句层与业务层分离呈现；业务失败时错误全文透传
      const biz = r.businessStatus === 'failed'
        ? `业务结果：失败 —— ${r.businessError ?? '（无错误详情）'}`
        : r.businessStatus === 'ok'
          ? '业务结果：成功'
          : '';
      const detail = (r.results ?? []).slice(0, 30).map((x) => {
        const out = x.outputs?.[0]?.rows?.[0]?.[0];
        return `#${x.idx} ${x.kind ?? ''} L${x.line} ${x.status}${x.affectedRows ? ` ${x.affectedRows}行` : ''}${x.durationMs !== undefined ? ` ${x.durationMs}ms` : ''}${out ? ` | ${out.slice(0, 120)}` : ''}${x.error ? ` | 错误: ${x.error}` : ''}`;
      });
      const verify = (r.verification ?? []).map((v) =>
        `${v.table}: ${v.delta === null || v.delta === undefined ? '—' : (v.delta >= 0 ? `+${v.delta}` : String(v.delta))} (${v.before ?? '?'}→${v.after ?? '?'})`);
      const parts = [];
      if (r.ok === false) {
        parts.push(`脚本执行失败${once}：已执行 ${r.executed}/${r.total} 条；失败在第 ${r.failedAtIndex} 条（第 ${r.error?.line} 行）——${r.error?.message ?? ''}`);
      } else {
        parts.push(`脚本已执行${once}：语句 ${r.executed}/${r.total} 成功${biz ? ` · ${biz}` : ''}，耗时 ${r.durationMs}ms`);
      }
      if (detail.length > 0) parts.push(`逐条明细：\n${detail.join('\n')}${(r.results ?? []).length > 30 ? `\n…共 ${r.results.length} 条` : ''}`);
      if (verify.length > 0) parts.push(`核验（参考值，并发写存在误差）：\n${verify.join('\n')}`);
      return parts.join('\n');
    }
    return `状态: ${res.status}${res.note ? `（${res.note}）` : ''}`;
  }
  if (name === 'script_history') {
    if (!res.entries?.length) return '（暂无脚本执行历史）';
    return res.entries.map((e) => `- ${new Date(e.at).toISOString()} ${e.connection} ${e.scriptNo ?? '-'} ${e.result}${e.failedAtIndex ? ` @第${e.failedAtIndex}条` : ''}${e.errorSummary ? `（${e.errorSummary}）` : ''}`).join('\n');
  }
  if (name === 'list_connections') {
    return res.connections.length === 0
      ? '（未配置连接——请在插件「数据库」面板添加）'
      : res.connections.map((c) => {
          const desc = c.description ? ` · ${c.description}` : '';
          if (c.ok === false) return `- ${c.name}（${c.dialect}${desc}，⚠ 配置失败：${c.reason}）`;
          return `- ${c.name}（${c.dialect}${desc}）`;
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
      if (mapped.on_error !== undefined) mapped.onError = mapped.on_error;
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
