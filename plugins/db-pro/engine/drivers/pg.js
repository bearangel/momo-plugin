'use strict';
// PostgreSQL 适配层（pg，纯 JS）。URL：postgres://user:pass@host:5432/dbname
// statement_timeout 池级生效（超时由服务端掐断）；DDL 由 catalog 拼装（spec §4.4）。
const { Pool } = require('pg');

function parseUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw new Error(`PG 连接串协议须为 postgres://（收到 ${u.protocol}//）`);
  }
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
  };
}

function qi(v) {
  if (!/^[A-Za-z0-9_$]+$/.test(String(v))) throw new Error(`非法标识符: ${v}`);
  return `"${v}"`;
}

async function createPool(connUrl, opts = {}) {
  const timeoutMs = opts.queryTimeoutMs ?? 30_000;
  const pool = new Pool({ connectionString: connUrl, max: 4, statement_timeout: timeoutMs });

  async function run(sql, values, maxRows) {
    const res = await pool.query({ text: sql, values: values ?? [], rowMode: 'array' });
    const rows = res.rows.map((r) => r.map((c) => {
      if (c === null || typeof c !== 'object' || c instanceof Date) return c;
      return JSON.stringify(c); // 数组/JSONB 等对象值串化
    }));
    const columns = (res.fields ?? []).map((f) => f.name);
    const truncated = rows.length > maxRows;
    return { columns, rows: truncated ? rows.slice(0, maxRows) : rows, total: rows.length, truncated, rowCount: res.rowCount ?? rows.length };
  }

  async function describe(schema, table) {
    const s = schema ?? 'public';
    const cols = await run(
      `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default, pgd.description
         FROM information_schema.columns c
         LEFT JOIN pg_catalog.pg_statio_all_tables st
           ON st.schemaname = c.table_schema AND st.relname = c.table_name
         LEFT JOIN pg_catalog.pg_description pgd
           ON pgd.objoid = st.relid AND pgd.objsubid = c.ordinal_position
        WHERE c.table_schema = $1 AND c.table_name = $2
        ORDER BY c.ordinal_position`, [s, table], 2_000);
    const pk = await run(
      `SELECT a.attname
         FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = ($1 || '.' || $2)::regclass AND i.indisprimary`, [s, table], 100);
    const est = await run(
      `SELECT reltuples::bigint FROM pg_class WHERE oid = ($1 || '.' || $2)::regclass`, [s, table], 1);
    return {
      columns: cols.rows.map(([name, type, nullable, dflt, comment]) => ({
        name, type, nullable: nullable === 'YES', default: dflt ?? null,
        key: pk.rows.some((x) => x[0] === name) ? 'PRI' : '', comment,
      })),
      indexes: [{ name: 'PRIMARY', columns: pk.rows.map((x) => x[0]), unique: true }],
      rowEstimate: est.rows[0]?.[0] ?? null,
    };
  }

  return {
    dialect: 'postgres',
    ping: () => pool.query('SELECT 1'),
    async query(sql, maxRows) {
      return await run(sql, [], maxRows);
    },
    async listSchemas() {
      const r = await run(
        `SELECT nspname FROM pg_namespace
          WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
          ORDER BY nspname`, [], 1_000);
      return r.rows.map((x) => x[0]);
    },
    async listTables(schema) {
      const s = schema ?? 'public';
      const r = await run(
        `SELECT schemaname, tablename, 'table' FROM pg_tables WHERE schemaname = $1
          UNION ALL
         SELECT schemaname, viewname, 'view' FROM pg_views WHERE schemaname = $1
          ORDER BY 2`, [s], 5_000);
      return r.rows.map(([sch, name, kind]) => ({ schema: sch, name, type: kind }));
    },
    async listViews(schema) {
      const s = schema ?? 'public';
      const r = await run(`SELECT schemaname, viewname FROM pg_views WHERE schemaname = $1 ORDER BY viewname`, [s], 2_000);
      return r.rows.map(([sch, name]) => ({ schema: sch, name }));
    },
    describe,
    async columns(schema, table) {
      return (await describe(schema, table)).columns;
    },
    async ddl(schema, table) {
      const s = schema ?? 'public';
      const d = await describe(s, table);
      const lines = d.columns.map((c) =>
        `  ${qi(c.name)} ${c.type}${c.nullable === false ? ' NOT NULL' : ''}${c.default !== null ? ` DEFAULT ${c.default}` : ''}`);
      const pk = d.indexes[0]?.columns ?? [];
      if (pk.length > 0) lines.push(`  PRIMARY KEY (${pk.map(qi).join(', ')})`);
      return `-- PG DDL 由 catalog 拼装（spec §4.4）\nCREATE TABLE ${qi(schema)}.${qi(table)} (\n${lines.join(',\n')}\n);`;
    },
    async explain(sql) {
      const r = await run(`EXPLAIN ${sql}`, [], 64);
      return { text: r.rows.map((x) => x[0]).join('\n'), operators: [], summary: `${r.rows.length} 行计划` };
    },
    async exec(sql) {
      const res = await pool.query({ text: sql, values: [] });
      return { affectedRows: res.rowCount ?? 0 };
    },
    async close() {
      await pool.end();
    },
  };
}

module.exports = { createPool, parseUrl };
