'use strict';
// db-pro 引擎子进程主体（spec §4.4）：连接池 Map + 方法调度 + 只读校验接线。
// 协议：NDJSON JSON-RPC（protocol.js）；驱动懒加载（缺方言不拖垮其他连接）。
const { runServer, EngineError, CODES } = require('./protocol');
const { assertReadOnly } = require('./sql-validator');
const { splitStatements, summarize, extractScriptNo } = require('./script-splitter');

const DIALECT_LOADERS = {
  mysql: () => require('./drivers/mysql'),
  postgres: () => require('./drivers/pg'),
  postgresql: () => require('./drivers/pg'),
  oracle: () => require('./drivers/oracle'),
  dm: () => require('./drivers/dm'),
  dameng: () => require('./drivers/dm'),
};

function dialectOfUrl(url) {
  try {
    return new URL(url).protocol.replace(':', '');
  } catch {
    return 'mysql';
  }
}

function createDispatcher(loadDriver = (d) => DIALECT_LOADERS[d](), pools = new Map()) {
  // 坏连接名 → 失败原因（configure 逐连接隔离，终审 I2：单连接失败不拖垮整批）
  const unavailable = new Map();

  function mustPool(name) {
    const h = pools.get(name);
    if (h) return h.pool;
    const reason = unavailable.get(name);
    if (reason) throw new EngineError(CODES.CONN, `连接 "${name}" 配置失败：${reason}——请修正连接串后重试`);
    throw new EngineError(CODES.CONN, `未配置的连接 "${name}"——请在插件设置中配置后重试`);
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
    // 新建：逐连接 try/catch（终审 I2）——坏槽记 unavailable 不炸整批 configure
    for (const c of connections ?? []) {
      const cur = pools.get(c.name);
      if (cur && cur.url === c.url && cur.queryTimeoutMs === c.queryTimeoutMs) continue;
      pools.delete(c.name);
      unavailable.delete(c.name);
      try {
        const proto = new URL(c.url).protocol.replace(':', '');
        const loader = DIALECT_LOADERS[proto];
        if (!loader) throw new EngineError(CODES.CONN, `不支持的连接协议 "${proto}://"（支持 mysql/postgres/oracle/dm）`);
        const pool = await loadDriver(proto).createPool(c.url, { queryTimeoutMs: c.queryTimeoutMs });
        pools.set(c.name, { name: c.name, url: c.url, queryTimeoutMs: c.queryTimeoutMs, pool });
      } catch (err) {
        unavailable.set(c.name, err instanceof Error ? err.message : String(err));
      }
    }
    return { configured: pools.size, unavailable: [...unavailable.entries()].map(([name, reason]) => ({ name, reason })) };
  }

  async function dispatch(method, params) {
    switch (method) {
      case 'ping': return { ready: true };
      case 'configure':
        return await applyConfigure(params.connections);
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
      // explain 前置只读校验（终审 C2）：EXPLAIN ANALYZE 在 PG 会真实执行所附
      // 语句——写语句走 explain 与走 query 同样必须被拦（首词白名单天然拒 ANALYZE/DML）
      case 'explain': {
        const explainCheck = assertReadOnly(params.sql);
        if (!explainCheck.ok) throw new EngineError(CODES.VALIDATION, explainCheck.reason);
        return await mustPool(params.connection).explain(params.sql);
      }
      case 'scriptAnalyze': {
        const r = splitStatements(params.script, params.dialect ?? 'mysql');
        return { ...r, summary: summarize(r.statements), scriptNo: extractScriptNo(params.script) };
      }
      // 脚本执行仅由 service 在人工批准后调用（与 exec 同侧边界）
      case 'scriptRun': {
        const handle = pools.get(params.connection);
        if (!handle) {
          const reason = unavailable.get(params.connection);
          throw new EngineError(CODES.CONN, reason
            ? `连接 "${params.connection}" 配置失败：${reason}`
            : `未配置的连接 "${params.connection}"——请在插件设置中配置后重试`);
        }
        const dialect = dialectOfUrl(handle.url);
        const { statements } = splitStatements(params.script, dialect);
        if (statements.length === 0) return { ok: true, total: 0, executed: 0, results: [], durationMs: 0 };
        const priv = statements.find((s) => s.cls === 'priv');
        if (priv) {
          throw new EngineError(CODES.VALIDATION, `第 ${priv.idx} 条为 GRANT/REVOKE——脚本通道不支持权限管理语句（DBA 域）`);
        }
        const onError = params.onError === 'continue' ? 'continue' : 'abort';
        const timeoutMs = Number.isFinite(params.scriptTimeoutMs) ? params.scriptTimeoutMs : 600_000;
        const started = Date.now();
        const session = await handle.pool.openSession();
        const results = [];
        let failedAtIndex = null;
        let failure = null;
        try {
          for (const s of statements) {
            if (Date.now() - started > timeoutMs) {
              failure = { code: 'script_timeout', message: `整脚本超时（${Math.round(timeoutMs / 1000)}s）——已中止`, line: s.line };
              break;
            }
            try {
              const r = await session.exec(s.text);
              results.push({ idx: s.idx, line: s.line, status: 'ok', affectedRows: r.affectedRows ?? 0 });
            } catch (err) {
              results.push({ idx: s.idx, line: s.line, status: 'failed', error: err instanceof Error ? err.message : String(err) });
              if (failedAtIndex === null) {
                failedAtIndex = s.idx;
                failure = { code: err?.code ?? 'driver_error', message: err instanceof Error ? err.message : String(err), line: s.line };
              }
              if (onError === 'abort') break;
            }
          }
          await session.finish(failure === null);
        } finally {
          await session.close();
        }
        return {
          ok: failure === null,
          total: statements.length,
          executed: results.length,
          results,
          ...(failedAtIndex !== null ? { failedAtIndex } : {}),
          ...(failure !== null ? { error: failure } : {}),
          durationMs: Date.now() - started,
        };
      }
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
