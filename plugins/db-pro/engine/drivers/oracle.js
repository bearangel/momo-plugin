'use strict';
// Oracle 适配层（oracledb thin 模式——12c+ 免 Instant Client；11g 不支持，spec D8）。
// URL：oracle://user:pass@host:1521/SERVICE_NAME（服务名必填）。
// 目录走 ALL_* 兼容视图；DDL 走 DBMS_METADATA；EXPLAIN 走 EXPLAIN PLAN + DBMS_XPLAN。
const oracledb = require('oracledb');
oracledb.fetchAsString = [oracledb.CLOB]; // DBMS_METADATA 等 CLOB 直接取文本

function parseUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'oracle:') throw new Error(`Oracle 连接串协议须为 oracle://（收到 ${u.protocol}//）`);
  const service = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (service === '') throw new Error('Oracle 连接串须带服务名：oracle://user:pass@host:1521/SERVICE');
  return {
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    connectString: `${u.hostname}:${u.port || 1521}/${service}`,
  };
}

async function createPool(connUrl, opts = {}) {
  const timeoutMs = opts.queryTimeoutMs ?? 30_000;
  const cfg = parseUrl(connUrl);
  const pool = await oracledb.createPool({
    user: cfg.user,
    password: cfg.password,
    connectString: cfg.connectString,
    poolMin: 0,
    poolMax: 4,
    poolIncrement: 1,
  });

  async function withConn(fn) {
    const conn = await pool.getConnection();
    try {
      conn.callTimeout = timeoutMs;
      return await fn(conn);
    } finally {
      await conn.close();
    }
  }

  async function runRows(sql, binds, maxRows) {
    return await withConn(async (conn) => {
      const res = await conn.execute(sql, binds ?? {}, { outFormat: oracledb.OUT_FORMAT_ARRAY, maxRows: maxRows + 1 });
      const rows = (res.rows ?? []).map((r) => r.map((c) => {
        if (c === null || typeof c !== 'object' || c instanceof Date) return c;
        return JSON.stringify(c);
      }));
      const truncated = rows.length > maxRows;
      return {
        columns: (res.metaData ?? []).map((md) => md.name),
        rows: truncated ? rows.slice(0, maxRows) : rows,
        total: rows.length,
        truncated,
      };
    });
  }

  async function describe(schema, table) {
    const cols = await runRows(
      `SELECT column_name,
              data_type || CASE WHEN char_length IS NOT NULL THEN '(' || char_length || ')' ELSE '' END,
              nullable, data_default
         FROM all_tab_columns WHERE owner = :o AND table_name = :t ORDER BY column_id`,
      { o: schema, t: table }, 2_000);
    const idxCols = await runRows(
      `SELECT i.index_name, c.column_name, i.uniqueness
         FROM all_indexes i
         JOIN all_ind_columns c ON c.index_name = i.index_name AND c.index_owner = i.owner
        WHERE i.table_owner = :o AND i.table_name = :t
        ORDER BY c.column_position`,
      { o: schema, t: table }, 2_000);
    const est = await runRows(
      `SELECT num_rows FROM all_tables WHERE owner = :o AND table_name = :t`,
      { o: schema, t: table }, 1);
    const byName = new Map();
    const indexes = [];
    for (const [name, column, uniq] of idxCols.rows) {
      if (!byName.has(name)) {
        const ix = { name, columns: [], unique: uniq === 'UNIQUE' };
        byName.set(name, ix);
        indexes.push(ix);
      }
      byName.get(name).columns.push(column);
    }
    return {
      columns: cols.rows.map(([name, type, nullable, dflt]) => ({
        name, type, nullable: nullable === 'Y', default: dflt ?? null, key: '', comment: '',
      })),
      indexes,
      rowEstimate: est.rows[0]?.[0] ?? null,
    };
  }

  return {
    dialect: 'oracle',
    async ping() {
      await runRows('SELECT 1 FROM dual', {}, 1);
    },
    async query(sql, maxRows) {
      return await runRows(sql, {}, maxRows);
    },
    async listSchemas() {
      const r = await runRows(
        `SELECT username FROM all_users WHERE oracle_maintained = 'N' ORDER BY username`, {}, 2_000);
      return r.rows.map((x) => x[0]);
    },
    async listTables(schema) {
      const o = schema ?? cfg.user.toUpperCase();
      const r = await runRows(
        `SELECT owner, table_name, 'table' FROM all_tables WHERE owner = :o
          UNION ALL
         SELECT owner, view_name, 'view' FROM all_views WHERE owner = :o
          ORDER BY 2`, { o }, 5_000);
      return r.rows.map(([s, n, t]) => ({ schema: s, name: n, type: t }));
    },
    async listViews(schema) {
      const o = schema ?? cfg.user.toUpperCase();
      const r = await runRows(`SELECT owner, view_name FROM all_views WHERE owner = :o ORDER BY view_name`, { o }, 2_000);
      return r.rows.map(([s, n]) => ({ schema: s, name: n }));
    },
    describe,
    async columns(schema, table) {
      return (await describe(schema, table)).columns;
    },
    async ddl(schema, table) {
      const r = await runRows(
        `SELECT DBMS_METADATA.GET_DDL('TABLE', :t, :s) FROM dual`, { t: table, s: schema }, 1);
      return String(r.rows[0]?.[0] ?? '');
    },
    async explain(sql) {
      return await withConn(async (conn) => {
        await conn.execute(`EXPLAIN PLAN FOR ${sql}`); // 仅生成计划，不执行语句
        const res = await conn.execute(
          'SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY())',
          {}, { outFormat: oracledb.OUT_FORMAT_ARRAY, maxRows: 128 });
        const lines = (res.rows ?? []).map((r) => String(r[0] ?? ''));
        return { text: lines.join('\n'), operators: [], summary: lines.find((l) => l.includes('Cost')) ?? '' };
      });
    },
    async exec(sql) {
      return await withConn(async (conn) => {
        const res = await conn.execute(sql);
        return { affectedRows: res.rowsAffected ?? 0 };
      });
    },
    async close() {
      await pool.close();
    },
  };
}

module.exports = { createPool, parseUrl };
