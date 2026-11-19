'use strict';
// MySQL 适配层（mysql2/promise，纯 JS）。URL：mysql://user:pass@host:3306/dbname
// 元数据走 information_schema；DDL 走 SHOW CREATE TABLE（spec §4.4）。
const mysql = require('mysql2/promise');

function parseUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'mysql:') throw new Error(`MySQL 连接串协议须为 mysql://（收到 ${u.protocol}//）`);
  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
  };
}

function quoteIdent(v) {
  if (!/^[A-Za-z0-9_$]+$/.test(String(v))) throw new Error(`非法标识符: ${v}`);
  return `\`${v}\``;
}

function lit(v) {
  return v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
}

/** Buffer → hex（BIT 列）；其余原样 */
function cell(c) {
  return Buffer.isBuffer(c) ? c.toString('hex') : c;
}

async function createPool(connUrl, opts = {}) {
  const timeoutMs = opts.queryTimeoutMs ?? 30_000;
  const cfg = parseUrl(connUrl);
  const pool = mysql.createPool({
    ...cfg,
    connectionLimit: 4,
    multipleStatements: false,
    dateStrings: true,
    supportBigNumbers: true,
  });

  /** 统一 run：SELECT/SHOW → rows 形态；无结果集语句 → header 形态 */
  async function run(sql, maxRows) {
    const [res, fields] = await pool.query({ sql, timeout: timeoutMs, rowsAsArray: true });
    if (!Array.isArray(res)) return { kind: 'header', affectedRows: res.affectedRows ?? 0 };
    const rows = res.map((r) => r.map(cell));
    const columns = (fields ?? []).map((f) => f.name);
    const truncated = rows.length > maxRows;
    return { kind: 'rows', columns, rows: truncated ? rows.slice(0, maxRows) : rows, total: rows.length, truncated };
  }

  async function describe(schema, table) {
    const s = schema ?? cfg.database;
    const cols = await run(
      `SELECT column_name, column_type, is_nullable, column_default, column_key, column_comment
         FROM information_schema.columns
        WHERE table_schema = ${lit(s)} AND table_name = ${lit(table)}
        ORDER BY ordinal_position`, 2_000);
    const idx = await run(
      `SELECT index_name, column_name, non_unique
         FROM information_schema.statistics
        WHERE table_schema = ${lit(s)} AND table_name = ${lit(table)}
        ORDER BY seq_in_index`, 2_000);
    const est = await run(
      `SELECT table_rows FROM information_schema.tables
        WHERE table_schema = ${lit(s)} AND table_name = ${lit(table)}`, 1);
    const byName = new Map();
    const indexes = [];
    for (const [name, column, nonUnique] of idx.rows) {
      if (!byName.has(name)) {
        const ix = { name, columns: [], unique: Number(nonUnique) === 0 };
        byName.set(name, ix);
        indexes.push(ix);
      }
      byName.get(name).columns.push(column);
    }
    return {
      columns: cols.rows.map(([name, type, nullable, dflt, key, comment]) => ({
        name, type, nullable: nullable === 'YES', default: dflt ?? null, key, comment,
      })),
      indexes,
      rowEstimate: est.rows[0]?.[0] ?? null,
    };
  }

  return {
    dialect: 'mysql',
    ping: () => pool.query('SELECT 1'),
    async query(sql, maxRows) {
      const r = await run(sql, maxRows);
      if (r.kind !== 'rows') throw new Error('该语句未返回结果集');
      return r;
    },
    async listSchemas() {
      const r = await run('SELECT schema_name FROM information_schema.schemata ORDER BY schema_name', 1_000);
      return r.rows.map((x) => x[0]);
    },
    async listTables(schema) {
      const s = schema ?? cfg.database;
      const r = await run(
        `SELECT table_schema, table_name, table_type FROM information_schema.tables
          WHERE table_schema = ${lit(s)} ORDER BY table_name`, 5_000);
      return r.rows.map(([sch, name, t]) => ({ schema: sch, name, type: t === 'VIEW' ? 'view' : 'table' }));
    },
    async listViews(schema) {
      const t = await this.listTables(schema);
      return t.filter((x) => x.type === 'view').map(({ schema: sch, name }) => ({ schema: sch, name }));
    },
    describe,
    async columns(schema, table) {
      return (await describe(schema, table)).columns;
    },
    async ddl(schema, table) {
      const s = schema ?? cfg.database;
      const r = await run(`SHOW CREATE TABLE ${quoteIdent(s)}.${quoteIdent(table)}`, 1);
      return String(r.rows[0]?.[1] ?? '');
    },
    async explain(sql) {
      const r = await run(`EXPLAIN ${sql}`, 64);
      const text = [r.columns.join(' | '), ...r.rows.map((row) => row.join(' | '))].join('\n');
      return { text, operators: [], summary: `${r.rows.length} 行计划` };
    },
    async exec(sql) {
      const r = await run(sql, 0);
      return { affectedRows: r.kind === 'header' ? r.affectedRows : r.rows.length };
    },
    async openSession() {
      const conn = await pool.getConnection();
      return {
        async exec(sql) {
          const [res] = await conn.query({ sql, timeout: timeoutMs });
          const affectedRows = Array.isArray(res) ? res.length : (res.affectedRows ?? 0);
          return { affectedRows };
        },
        async finish() {},
        async close() { conn.release(); },
      };
    },
    async close() {
      await pool.end();
    },
  };
}

module.exports = { createPool, parseUrl, quoteIdent };
