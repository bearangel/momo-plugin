'use strict';
// db-pro 引擎子进程主体（spec §4.4）：连接池 Map + 方法调度 + 只读校验接线。
// 协议：NDJSON JSON-RPC（protocol.js）；驱动懒加载（缺方言不拖垮其他连接）。
const { runServer, EngineError, CODES } = require('./protocol');
const { runPrecheck } = require('./precheck');
const { assertReadOnly } = require('./sql-validator');
const { splitStatements, summarize, extractScriptNo, classifyStatement, detectTemplateIssues } = require('./script-splitter');
const { LEGACY_FULL, hasBit, missingBits, requiredBitsForClass } = require('./permissions');

// 层 1 失败标记默认正则（spec 2026-11-20 §4.1）：DAP-E 模板约定 handler 失败分支
// SELECT '[FAIL] …'——任一输出单元格命中即业务失败；连接级 scriptJudge.failPattern 可覆盖。
const DEFAULT_FAIL_PATTERN = /^\[FAIL\]/;

function compilePattern(p) {
  try { return new RegExp(p); } catch { return DEFAULT_FAIL_PATTERN; } // 配置侧已校验，此处兜底不炸
}

function judgeIdentOk(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_$#]{1,64}$/.test(v);
}

function stringLit(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

// 层 2 权威判定（spec 2026-11-20 §4.2）：按脚本号查日志表最新一行，表内状态为权威。
// 排序依据：scriptJudge.sortColumn > 探测自增主键 > 不可用告警（不猜）。
async function queryScriptLog(session, judge, scriptNo) {
  try {
    let orderCol = judge.sortColumn ?? null;
    if (!orderCol) {
      const probe = await session.exec(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${stringLit(judge.logTable)} AND EXTRA LIKE '%auto_increment%'`);
      const v = probe?.outputs?.[0]?.rows?.[0]?.[0];
      if (judgeIdentOk(v)) orderCol = v;
    }
    if (!orderCol) return { status: 'unavailable', note: '日志表无排序列（未配 sortColumn 且探测不到自增主键）——层 2 不可用' };
    const cols = [judge.statusColumn, ...(judge.errorColumn ? [judge.errorColumn] : []), orderCol].join(', ');
    const r = await session.exec(
      `SELECT ${cols} FROM ${judge.logTable} WHERE ${judge.scriptNoColumn} = ${stringLit(scriptNo)} ORDER BY ${orderCol} DESC LIMIT 1`);
    const row = r?.outputs?.[0]?.rows?.[0];
    if (!row) return { status: 'unavailable', note: '日志表无该脚本号记录——层 2 不可用' };
    const ok = String(row[0]) === String(judge.okValue);
    const errVal = judge.errorColumn && row[1] !== undefined && row[1] !== 'NULL' && row[1] !== 'null' ? String(row[1]) : null;
    return ok ? { status: 'ok' } : { status: 'failed', error: errVal };
  } catch (err) {
    return { status: 'unavailable', note: `层 2 查询失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

function scanFailureMarker(outputs, pattern = DEFAULT_FAIL_PATTERN) {
  for (const out of outputs ?? []) {
    for (const row of out.rows ?? []) {
      for (const cellText of row) {
        if (pattern.test(cellText)) return cellText;
      }
    }
  }
  return null;
}

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

  // R7（spec 2026-11-20 §8.1）：报错附可用连接列表，误用旧名可自我纠错
  function connError(name) {
    const reason = unavailable.get(name);
    const avail = [...pools.keys()];
    const tail = avail.length === 0
      ? '当前无已配置连接——请到插件面板添加'
      : `当前可用：${avail.join('、')}`;
    return new EngineError(CODES.CONN, reason
      ? `连接 "${name}" 配置失败：${reason}——请修正连接串后重试`
      : `未配置的连接 "${name}"（${tail}）`);
  }

  function mustPool(name) {
    const h = pools.get(name);
    if (h) return h.pool;
    throw connError(name);
  }

  async function applyConfigure(connections) {
    const next = new Map((connections ?? []).map((c) => [c.name, c]));
    // 关闭：不在新配置、或 url/timeout 变化的
    for (const [name, h] of pools) {
      const n = next.get(name);
      const permsSame = n && JSON.stringify(h.permissions) === JSON.stringify(n.permissions ?? LEGACY_FULL);
      const judgeSame = n && JSON.stringify(h.scriptJudge ?? null) === JSON.stringify(n.scriptJudge ?? null);
      if (!n || n.url !== h.url || n.queryTimeoutMs !== h.queryTimeoutMs || !permsSame || !judgeSame) {
        pools.delete(name);
        void h.pool.close().catch(() => undefined);
      }
    }
    // 新建：逐连接 try/catch（终审 I2）——坏槽记 unavailable 不炸整批 configure
    for (const c of connections ?? []) {
      const cur = pools.get(c.name);
      if (cur && cur.url === c.url && cur.queryTimeoutMs === c.queryTimeoutMs
        && JSON.stringify(cur.permissions) === JSON.stringify(c.permissions ?? LEGACY_FULL)
        && JSON.stringify(cur.scriptJudge ?? null) === JSON.stringify(c.scriptJudge ?? null)) continue;
      pools.delete(c.name);
      unavailable.delete(c.name);
      try {
        const proto = new URL(c.url).protocol.replace(':', '');
        const loader = DIALECT_LOADERS[proto];
        if (!loader) throw new EngineError(CODES.CONN, `不支持的连接协议 "${proto}://"（支持 mysql/postgres/oracle/dm）`);
        const pool = await loadDriver(proto).createPool(c.url, { queryTimeoutMs: c.queryTimeoutMs });
        pools.set(c.name, {
          name: c.name,
          url: c.url,
          queryTimeoutMs: c.queryTimeoutMs,
          permissions: Array.isArray(c.permissions) ? c.permissions : LEGACY_FULL,
          scriptJudge: c.scriptJudge ?? null,
          pool,
        });
      } catch (err) {
        unavailable.set(c.name, err instanceof Error ? err.message : String(err));
      }
    }
    return { configured: pools.size, unavailable: [...unavailable.entries()].map(([name, reason]) => ({ name, reason })) };
  }

  function permsOf(name) {
    const h = pools.get(name);
    return h ? h.permissions : LEGACY_FULL;
  }

  function assertPerm(name, cls) {
    const missing = requiredBitsForClass(cls).filter((b) => !hasBit(permsOf(name), b));
    if (missing.length > 0) {
      throw new EngineError(
        CODES.VALIDATION,
        `连接 "${name}" 未授权 ${missing.join('/')} 操作——请在插件面板「数据库」中调整该连接权限`,
      );
    }
  }

  function assertScriptPerm(name, statements) {
    if (!hasBit(permsOf(name), 'script')) {
      throw new EngineError(CODES.VALIDATION, `连接 "${name}" 未授权 script（脚本执行）——请在插件面板「数据库」中开启该权限`);
    }
    for (const s of statements) {
      const missing = missingBits(permsOf(name), s.cls);
      if (missing.length > 0) {
        throw new EngineError(
          CODES.VALIDATION,
          `第 ${s.idx} 条（第 ${s.line} 行）需要 ${missing.join('/')} 权限——连接 "${name}" 未授权`,
        );
      }
    }
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
        assertPerm(params.connection, 'read');
        const check = assertReadOnly(params.sql);
        if (!check.ok) throw new EngineError(CODES.VALIDATION, check.reason);
        return await mustPool(params.connection).query(params.sql, params.maxRows ?? 200);
      }
      case 'meta.listSchemas': assertPerm(params.connection, 'read'); return { schemas: await mustPool(params.connection).listSchemas() };
      case 'meta.listTables': assertPerm(params.connection, 'read'); return { tables: await mustPool(params.connection).listTables(params.schema) };
      case 'meta.listViews': assertPerm(params.connection, 'read'); return { views: await mustPool(params.connection).listViews(params.schema) };
      case 'meta.describe': assertPerm(params.connection, 'read'); return await mustPool(params.connection).describe(params.schema, params.table);
      case 'meta.columns': assertPerm(params.connection, 'read'); return { columns: await mustPool(params.connection).columns(params.schema, params.table) };
      case 'meta.ddl': assertPerm(params.connection, 'read'); return { ddl: await mustPool(params.connection).ddl(params.schema, params.table) };
      // explain 前置只读校验（终审 C2）：EXPLAIN ANALYZE 在 PG 会真实执行所附
      // 语句——写语句走 explain 与走 query 同样必须被拦（首词白名单天然拒 ANALYZE/DML）
      case 'explain': {
        assertPerm(params.connection, 'read');
        const explainCheck = assertReadOnly(params.sql);
        if (!explainCheck.ok) throw new EngineError(CODES.VALIDATION, explainCheck.reason);
        return await mustPool(params.connection).explain(params.sql);
      }
      case 'scriptAnalyze': {
        const r = splitStatements(params.script, params.dialect ?? 'mysql');
        const issues = detectTemplateIssues(r.statements);
        if (issues.length > 0) r.warnings.push(...issues);
        return { ...r, summary: summarize(r.statements), scriptNo: extractScriptNo(params.script) };
      }
      // 连库预检（spec 2026-11-20 §6）：只读 information_schema + COUNT，dryrun 咨询性质
      case 'scriptPrecheck': {
        const handle = pools.get(params.connection);
        if (!handle) throw connError(params.connection);
        assertPerm(params.connection, 'read');
        const dialect = dialectOfUrl(handle.url);
        const { statements } = splitStatements(params.script, dialect);
        return await runPrecheck(handle.pool, statements, dialect);
      }
      // 脚本执行仅由 service 在人工批准后调用（与 exec 同侧边界）
      case 'scriptRun': {
        const handle = pools.get(params.connection);
        if (!handle) throw connError(params.connection);
        const dialect = dialectOfUrl(handle.url);
        const { statements } = splitStatements(params.script, dialect);
        if (statements.length === 0) return { ok: true, total: 0, executed: 0, results: [], durationMs: 0 };
        const priv = statements.find((s) => s.cls === 'priv');
        if (priv) {
          throw new EngineError(CODES.VALIDATION, `第 ${priv.idx} 条为 GRANT/REVOKE——脚本通道不支持权限管理语句（DBA 域）`);
        }
        assertScriptPerm(params.connection, statements);
        const onError = params.onError === 'continue' ? 'continue' : 'abort';
        const timeoutMs = Number.isFinite(params.scriptTimeoutMs) ? params.scriptTimeoutMs : 600_000;
        const started = Date.now();
        const session = await handle.pool.openSession();
        // R6 核验快照（spec §7.2）：推断表去重取前 20，语句循环前后各 COUNT 一次
        const verifyTables = [...new Set(statements.flatMap((s) => s.tables ?? []))].slice(0, 20);
        const beforeCounts = new Map();
        for (const t of verifyTables) beforeCounts.set(t, await session.count(t));
        const results = [];
        let failedAtIndex = null;
        let failure = null;
        try {
          for (const s of statements) {
            if (Date.now() - started > timeoutMs) {
              failure = { code: 'script_timeout', message: `整脚本超时（${Math.round(timeoutMs / 1000)}s）——已中止`, line: s.line };
              break;
            }
            const t0 = Date.now();
            try {
              const r = await session.exec(s.text);
              results.push({ idx: s.idx, line: s.line, kind: s.keyword, status: 'ok',
                affectedRows: r.affectedRows ?? 0, outputs: r.outputs ?? null, durationMs: Date.now() - t0 });
            } catch (err) {
              results.push({ idx: s.idx, line: s.line, kind: s.keyword, status: 'failed',
                error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - t0 });
              if (failedAtIndex === null) {
                failedAtIndex = s.idx;
                failure = { code: err?.code ?? 'driver_error', message: err instanceof Error ? err.message : String(err), line: s.line };
              }
              if (onError === 'abort') break;
            }
          }
          await session.finish(failure === null);
          // 业务判定链（spec §4.3）：语句失败 > 层 2（scriptJudge，接线见 §4.2 任务）> 层 1 > ok
          let businessStatus = 'ok';
          let businessError = null;
          let businessSource = null;
          let layer2Note = null;
          if (failure !== null) {
            businessStatus = 'failed';
            businessError = failure.message;
            businessSource = 'statement';
          } else {
            const judge = handle.scriptJudge;
            const scriptNo = extractScriptNo(params.script);
            let l2 = null;
            if (judge?.logTable && scriptNo) l2 = await queryScriptLog(session, judge, scriptNo);
            if (l2 && (l2.status === 'ok' || l2.status === 'failed')) {
              businessStatus = l2.status;
              businessError = l2.status === 'ok' ? null : (l2.error ?? '（日志表未提供错误信息）');
              businessSource = 'layer2_logtable';
            } else {
              const pattern = judge?.failPattern ? compilePattern(judge.failPattern) : DEFAULT_FAIL_PATTERN;
              const marker = scanFailureMarker(results.flatMap((x) => x.outputs ?? []), pattern);
              if (marker) {
                businessStatus = 'failed';
                businessError = marker;
                businessSource = 'layer1_marker';
              }
            }
            if (l2?.status === 'unavailable') layer2Note = l2.note;
          }
          const verification = [];
          for (const t of verifyTables) {
            const b = beforeCounts.get(t) ?? null;
            const a = await session.count(t);
            verification.push({ table: t, before: b, after: a, delta: b !== null && a !== null ? a - b : null });
          }
          return {
            ok: failure === null,
            total: statements.length,
            executed: results.length,
            results,
            businessStatus,
            ...(businessError !== null ? { businessError } : {}),
            ...(businessSource !== null ? { businessSource } : {}),
            ...(layer2Note !== null ? { layer2Note } : {}),
            ...(verifyTables.length > 0 ? { verification } : {}),
            ...(failedAtIndex !== null ? { failedAtIndex } : {}),
            ...(failure !== null ? { error: failure } : {}),
            durationMs: Date.now() - started,
          };
        } finally {
          await session.close();
        }
      }
      // exec 仅由 service 在人工批准后调用（spec §6.2：引擎协议不暴露给 agent）
      case 'exec': {
        const cls = classifyStatement(params.sql).cls;
        if (cls === 'priv') {
          throw new EngineError(CODES.VALIDATION, '不支持 GRANT/REVOKE 等权限管理语句（DBA 域）');
        }
        assertPerm(params.connection, cls);
        return await mustPool(params.connection).exec(params.sql);
      }
      case 'probe': {
        const proto = new URL(params.url).protocol.replace(':', '');
        const loader = DIALECT_LOADERS[proto];
        if (!loader) throw new EngineError(CODES.CONN, `不支持的连接协议 "${proto}://"（支持 mysql/postgres/oracle/dm）`);
        const driver = loadDriver(proto);
        if (typeof driver.probeUrl === 'function') {
          await driver.probeUrl(params.url);
          return { ok: true };
        }
        const tmp = await driver.createPool(params.url, { queryTimeoutMs: params.queryTimeoutMs ?? 30_000 });
        try { await tmp.ping(); } finally { await tmp.close().catch(() => undefined); }
        return { ok: true };
      }
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
