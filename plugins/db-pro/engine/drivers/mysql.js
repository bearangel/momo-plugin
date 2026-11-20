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

// ── 脚本通道结果归一（spec 2026-11-20 §4.1/§7.1）──────────────────
// mysql2 对 CALL 返回 [结果集数组, fields]；结果集元素可能是行数组（有
// 输出）或 OkPacket（DML 尾包）。旧实现把结果集个数当影响行数——废除：
// 输出捕获进 outputs（每集前 50 行、单元格 200 字），影响行数取最后一个 OkPacket。
const OUTPUT_MAX_ROWS = 50;
const OUTPUT_CELL_MAX = 200;

function isOkPacket(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
    && ('affectedRows' in x || 'insertId' in x || 'serverStatus' in x);
}

function toOutput(set) {
  if (!Array.isArray(set) || set.length === 0) return null;
  const columns = Object.keys(set[0] ?? {});
  if (columns.length === 0) return null;
  const rows = set.slice(0, OUTPUT_MAX_ROWS)
    .map((r) => columns.map((c) => String(cell(r[c]) ?? '').slice(0, OUTPUT_CELL_MAX)));
  return { columns, rows };
}

function normalizeMysqlResults(res) {
  if (isOkPacket(res)) return { affectedRows: res.affectedRows ?? 0, outputs: null };
  if (Array.isArray(res) && res.length > 0 && !isOkPacket(res[0]) && !Array.isArray(res[0])) {
    const out = toOutput(res);
    return { affectedRows: out ? out.rows.length : 0, outputs: out ? [out] : null };
  }
  if (Array.isArray(res)) {
    const outputs = res.map(toOutput).filter(Boolean);
    const lastOk = [...res].reverse().find(isOkPacket);
    return { affectedRows: lastOk?.affectedRows ?? 0, outputs: outputs.length > 0 ? outputs : null };
  }
  return { affectedRows: 0, outputs: null };
}

/** 会话工厂（导出以便单测注入假 conn）：exec 带结果集捕获；count 供核验快照 */
function createMysqlSession(conn, timeoutMs) {
  let aligned = false;
  // R3（spec §5）：驱动默认会话 collation（utf8mb4_unicode_ci）≠ 目标库默认
  // （如 utf8mb4_0900_ai_ci）时，过程/用户变量与表列比较会炸 Illegal mix
  // of collations——首次 exec 前对齐到 @@collation_database；脚本自带
  // SET NAMES 时后执行自然覆盖。charset 名来自服务器变量，白名单防注入。
  async function alignCollationOnce() {
    if (aligned) return;
    aligned = true;
    try {
      const [res] = await conn.query({
        sql: 'SELECT @@character_set_database AS cs, @@collation_database AS dbColl, @@collation_connection AS connColl',
        timeout: timeoutMs,
      });
      const r = Array.isArray(res) ? res[0] : null;
      if (r && r.dbColl && r.dbColl !== r.connColl && /^[A-Za-z0-9_]+$/.test(String(r.cs))) {
        await conn.query({ sql: `SET NAMES ${r.cs} COLLATE ${r.dbColl}`, timeout: timeoutMs });
      }
    } catch { /* 探查失败不阻断脚本执行 */ }
  }
  return {
    async exec(sql) {
      await alignCollationOnce();
      const [res] = await conn.query({ sql, timeout: timeoutMs });
      return normalizeMysqlResults(res);
    },
    async count(table) {
      try {
        const [res] = await conn.query({ sql: `SELECT COUNT(*) AS c FROM ${quoteIdent(table)}`, timeout: timeoutMs });
        const v = Array.isArray(res) ? res[0]?.c : undefined;
        return typeof v === 'number' ? v : null;
      } catch { return null; } // 表不存在/非法名 → null，核验降级不炸
    },
    async finish() {},
    async close() { conn.release(); },
  };
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
    connectTimeout: opts.connectTimeoutMs ?? 10_000,
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
      return createMysqlSession(conn, timeoutMs);
    },
    async close() {
      await pool.end();
    },
  };
}

module.exports = { createPool, parseUrl, quoteIdent, normalizeMysqlResults, createMysqlSession };
