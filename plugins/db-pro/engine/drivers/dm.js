'use strict';
// 达梦 DM8 适配层（dmdb 官方 npm 驱动，纯 JS）。URL：dm://user:pass@host:5236[/SCHEMA]
// 关键特化（spec §1.3 事实 3）：EXPLAIN 不返回结果集——计划文本在驱动
// lastExecInfo.explain，本层读取并解析为 {text, operators, summary}。
// 连接形态经 Spike #0 实测确定（RESULT.md 附注）：
//   createPool({connectString: 'dm://user:pwd@host:port'})——分离 host/port 报 [20001]，
//   host:port 裸串报 "URL must start with 'dm://'"；Pool 无 execute，须 getConnection。
const dmdb = require('dmdb');
// CLOB 结果列直接取文本（DBMS_METADATA.GET_DDL 等）——否则回 Lob 对象（内含
// BigInt 字段，JSON.stringify 抛异常；index.d.ts：fetchAsString 可选 CLOB）
dmdb.fetchAsString = [dmdb.CLOB];

function parseUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'dm:' && u.protocol !== 'dameng:') {
    throw new Error(`达梦连接串协议须为 dm://（收到 ${u.protocol}//）`);
  }
  const user = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  const schema = decodeURIComponent(u.pathname.replace(/^\//, ''));
  return {
    host: u.hostname,
    port: Number(u.port || 5236),
    user,
    password,
    schema: schema !== '' ? schema.toUpperCase() : user.toUpperCase(),
    connectString: url, // dmdb createPool 直接收完整 dm:// URL
  };
}

/** 计划文本解析：算子行形如 `2  #PRJT2: [...]`——#后的算子名序列 + 首行摘要 */
function parseExplainPlan(text) {
  const t = String(text ?? '');
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  const operators = lines
    .map((l) => (l.match(/#\s*([A-Z][A-Z0-9]*)/) ?? [])[1])
    .filter(Boolean);
  return { text: t, operators, summary: lines[0] ?? '' };
}

/** 结果行归一：dmdb 行可能为数组（oracledb ARRAY 形态）或对象（metaData 序） */
function normalizeRows(res) {
  const meta = (res.metaData ?? []).map((md) => md.name);
  const raw = res.rows ?? [];
  const rows = raw.map((r) => (Array.isArray(r) ? r : meta.map((k) => r?.[k])));
  const columns = meta.length > 0
    ? meta
    : (raw[0] !== undefined && !Array.isArray(raw[0]) ? Object.keys(raw[0]) : []);
  return { columns, rows };
}

/** 单元格归一：BigInt（含对象包装——dmdb 数值列）转字符串，对象值串化 */
function dmCell(c) {
  if (c === null || c === undefined) return c;
  if (c instanceof Date) return c;
  const v = typeof c === 'object' && typeof c.valueOf === 'function' ? c.valueOf() : c;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v !== 'object' || v === null) return v;
  return JSON.stringify(c);
}

async function createPool(connUrl, opts = {}) {
  const cfg = parseUrl(connUrl);
  void opts; // queryTimeoutMs 由 SQL 层管（dmdb 无池级超时选项——集成实测如可注入再补）
  const pool = await dmdb.createPool({ connectString: cfg.connectString });

  async function withConn(fn) {
    const conn = await pool.getConnection();
    try {
      return await fn(conn);
    } finally {
      await conn.close();
    }
  }

  async function runRows(sql, binds, maxRows) {
    return await withConn(async (conn) => {
      const res = await conn.execute(sql, binds ?? {});
      const { columns, rows } = normalizeRows(res);
      const norm = rows.map((r) => r.map(dmCell));
      const truncated = norm.length > maxRows;
      return { columns, rows: truncated ? norm.slice(0, maxRows) : norm, total: norm.length, truncated };
    });
  }

  async function describe(schema, table) {
    const s = schema ?? cfg.schema;
    const cols = await runRows(
      `SELECT COLUMN_NAME, DATA_TYPE, NULLABLE, DATA_DEFAULT
         FROM ALL_TAB_COLUMNS WHERE OWNER = :o AND TABLE_NAME = :t ORDER BY COLUMN_ID`,
      { o: s, t: table }, 2_000);
    const est = await runRows(
      `SELECT NUM_ROWS FROM ALL_TABLES WHERE OWNER = :o AND TABLE_NAME = :t`, { o: s, t: table }, 1);
    return {
      columns: cols.rows.map(([name, type, nullable, dflt]) => ({
        name: String(name), type: String(type), nullable: String(nullable) === 'Y', default: dflt ?? null, key: '', comment: '',
      })),
      indexes: [],
      rowEstimate: est.rows[0]?.[0] ?? null,
    };
  }

  return {
    dialect: 'dm',
    async ping() {
      await runRows('SELECT 1 FROM DUAL', {}, 1);
    },
    async query(sql, maxRows) {
      return await runRows(sql, {}, maxRows);
    },
    async listSchemas() {
      const r = await runRows(`SELECT USERNAME FROM ALL_USERS ORDER BY USERNAME`, {}, 2_000);
      return r.rows.map((x) => String(x[0]));
    },
    async listTables(schema) {
      const o = schema ?? cfg.schema;
      const r = await runRows(
        `SELECT OWNER, TABLE_NAME, 'table' FROM ALL_TABLES WHERE OWNER = :o
          UNION ALL
         SELECT OWNER, VIEW_NAME, 'view' FROM ALL_VIEWS WHERE OWNER = :o
          ORDER BY 2`, { o }, 5_000);
      return r.rows.map(([s, n, t]) => ({ schema: String(s), name: String(n), type: String(t) }));
    },
    async listViews(schema) {
      const o = schema ?? cfg.schema;
      const r = await runRows(`SELECT OWNER, VIEW_NAME FROM ALL_VIEWS WHERE OWNER = :o ORDER BY VIEW_NAME`, { o }, 2_000);
      return r.rows.map(([s, n]) => ({ schema: String(s), name: String(n) }));
    },
    describe,
    async columns(schema, table) {
      return (await describe(schema, table)).columns;
    },
    async ddl(schema, table) {
      // DM8 兼容 DBMS_METADATA 包；若集成实测不可用，改 catalog 拼装（同 pg.js ddl 实现）
      const s = schema ?? cfg.schema;
      const r = await runRows(
        `SELECT DBMS_METADATA.GET_DDL('TABLE', :t, :s) FROM DUAL`, { t: table, s }, 1);
      return String(r.rows[0]?.[0] ?? '');
    },
    async explain(sql) {
      return await withConn(async (conn) => {
        await conn.execute(`EXPLAIN ${sql}`);
        const text = conn.lastExecInfo?.explain ?? '';
        if (text === '') throw new Error('达梦未返回执行计划（lastExecInfo.explain 为空）');
        return parseExplainPlan(text);
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

module.exports = { createPool, parseUrl, parseExplainPlan };
