'use strict';
// db-pro 引擎子进程主体（spec §4.4）：连接池 Map + 方法调度 + 只读校验接线。
// 协议：NDJSON JSON-RPC（protocol.js）；驱动懒加载（缺方言不拖垮其他连接）。
const { runServer, EngineError, CODES } = require('./protocol');
const { assertReadOnly } = require('./sql-validator');

const DIALECT_LOADERS = {
  mysql: () => require('./drivers/mysql'),
  postgres: () => require('./drivers/pg'),
  postgresql: () => require('./drivers/pg'),
  oracle: () => require('./drivers/oracle'),
  dm: () => require('./drivers/dm'),
  dameng: () => require('./drivers/dm'),
};

function createDispatcher(loadDriver = (d) => DIALECT_LOADERS[d](), pools = new Map()) {
  function mustPool(name) {
    const h = pools.get(name);
    if (!h) throw new EngineError(CODES.CONN, `未配置的连接 "${name}"——请在插件设置中配置后重试`);
    return h.pool;
  }

  async function applyConfigure(connections) {
    const next = new Map((connections ?? []).map((c) => [c.name, c]));
    // 关闭：不在新配置、或 url/timeout 变化的
    for (const [name, h] of pools) {
      const n = next.get(name);
      if (!n || n.url !== h.url || n.queryTimeoutMs !== h.queryTimeoutMs) {
        pools.delete(name);
        void h.pool.close().catch(() => undefined);
      }
    }
    // 新建
    for (const c of connections ?? []) {
      const cur = pools.get(c.name);
      if (cur && cur.url === c.url && cur.queryTimeoutMs === c.queryTimeoutMs) continue;
      const proto = new URL(c.url).protocol.replace(':', '');
      const loader = DIALECT_LOADERS[proto];
      if (!loader) throw new EngineError(CODES.CONN, `不支持的连接协议 "${proto}://"（支持 mysql/postgres/oracle/dm）`);
      const pool = await loadDriver(proto).createPool(c.url, { queryTimeoutMs: c.queryTimeoutMs });
      pools.set(c.name, { name: c.name, url: c.url, queryTimeoutMs: c.queryTimeoutMs, pool });
    }
  }

  async function dispatch(method, params) {
    switch (method) {
      case 'ping': return { ready: true };
      case 'configure':
        await applyConfigure(params.connections);
        return { configured: pools.size };
      case 'connTest':
        await mustPool(params.name).ping();
        return { ok: true };
      case 'query': {
        const check = assertReadOnly(params.sql);
        if (!check.ok) throw new EngineError(CODES.VALIDATION, check.reason);
        return await mustPool(params.connection).query(params.sql, params.maxRows ?? 200);
      }
      case 'meta.listSchemas': return { schemas: await mustPool(params.connection).listSchemas() };
      case 'meta.listTables': return { tables: await mustPool(params.connection).listTables(params.schema) };
      case 'meta.listViews': return { views: await mustPool(params.connection).listViews(params.schema) };
      case 'meta.describe': return await mustPool(params.connection).describe(params.schema, params.table);
      case 'meta.columns': return { columns: await mustPool(params.connection).columns(params.schema, params.table) };
      case 'meta.ddl': return { ddl: await mustPool(params.connection).ddl(params.schema, params.table) };
      case 'explain': return await mustPool(params.connection).explain(params.sql);
      // exec 仅由 service 在人工批准后调用（spec §6.2：引擎协议不暴露给 agent）
      case 'exec': return await mustPool(params.connection).exec(params.sql);
      default: throw new EngineError(CODES.UNKNOWN_METHOD, `未知方法: ${method}`);
    }
  }

  return { dispatch, pools, applyConfigure };
}

if (require.main === module) {
  const { dispatch, pools } = createDispatcher();
  process.on('SIGTERM', () => {
    void Promise.allSettled([...pools.values()].map((h) => h.pool.close())).then(() => process.exit(0));
  });
  runServer(dispatch);
}

module.exports = { createDispatcher };
