'use strict';
// 连库预检（spec 2026-11-20 §6，R4）：只读查询 information_schema + COUNT 探测。
// 产出分级 items（info/warn/high）不阻断；MySQL 先行，其余方言显式不支持。
// pool 契约：pool.query(sql) → { columns, rows }（rows 为数组形态，同引擎 run）。

const TABLE_CAP = 50;
const PRECHECK_BUDGET_MS = 30_000;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$#]*$/;

// ── INSERT 静态解析（纯函数）──────────────────────────────────
// 返回 {table, columns|null, literals[]}：literals 每列一个，非字面量位为 null。
// 字面量形态：'str' / 数字 / NULL / TRUE / FALSE；其余（@var、函数、表达式）= null。
function extractInsertInfo(text) {
  const m = String(text).match(/insert\s+(?:into|replace\s+into)\s+([A-Za-z0-9_$."`[\]]+)\s*(\(([^()]*(?:\([^()]*\)[^()]*)*)\))?\s*values\s*\(/i);
  if (!m) return null;
  const table = m[1].replace(/["`[\]]/g, '').split('.').pop();
  let columns = null;
  if (m[3]) columns = m[3].split(',').map((c) => c.trim().replace(/["`]/g, ''));
  const lower = String(text).toLowerCase();
  const vIdx = lower.lastIndexOf('values');
  const tail = String(text).slice(vIdx);
  const open = tail.indexOf('(');
  if (open < 0) return { table, columns, literals: null };
  let depth = 0;
  let end = -1;
  for (let i = open; i < tail.length; i += 1) {
    const c = tail[i];
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return { table, columns, literals: null };
  const literals = splitTopLevel(tail.slice(open + 1, end)).map((v) => {
    const t = v.trim();
    if (/^'(?:[^']|'')*'$/.test(t) || /^-?\d+(\.\d+)?$/.test(t) || /^(NULL|TRUE|FALSE)$/i.test(t)) return t;
    return null;
  });
  return { table, columns, literals };
}

/** 顶层逗号切分（忽略括号嵌套与单引号串内逗号） */
function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  let q = null;
  for (const c of s) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === "'") { q = c; cur += c; continue; }
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

function sqlLit(literal) {
  // 字面量已是带引号/裸数字形态，直接拼入；字面量本身不含未转义引号（regex 已保证）
  return literal;
}

async function runPrecheck(pool, statements, dialect) {
  if (dialect !== 'mysql') {
    return { supported: false, note: '该方言暂不支持预检', items: [] };
  }
  const started = Date.now();
  const items = [];
  const stmts = statements ?? [];

  // 目标表（含存储过程体内 INSERT 推断）去重，非法名剔除，cap 50
  const insertInfos = [];
  for (const s of stmts) {
    if (s.cls === 'procedure' || s.cls === 'block') {
      // 过程体按 ';' 分片逐一解析（体内 INSERT 语句参与列匹配/UK 预演）
      for (const frag of s.text.split(';')) {
        const info = extractInsertInfo(frag);
        if (info) insertInfos.push({ info, line: s.line });
      }
    } else if (extractInsertInfo(s.text)) {
      insertInfos.push({ info: extractInsertInfo(s.text), line: s.line });
    }
  }
  const targetTables = [...new Set([
    ...stmts.flatMap((s) => s.tables ?? []),
    ...insertInfos.map((x) => x.info.table),
  ])].filter((t) => IDENT_RE.test(t)).slice(0, TABLE_CAP);
  if (targetTables.length === 0) return { supported: true, items };

  const inList = targetTables.map((t) => `'${t}'`).join(', ');
  const createdInScript = new Set(stmts
    .filter((s) => s.cls === 'ddl_table' && /^create/i.test(s.keyword))
    .flatMap((s) => s.tables ?? []));

  // 检查 1+4：表存在性与 collation（一次查询两用）
  const dbTables = new Map();
  try {
    const r = await pool.query(
      `SELECT TABLE_NAME, TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${inList})`);
    for (const row of r.rows ?? []) dbTables.set(String(row[0]), String(row[1] ?? ''));
  } catch (err) {
    items.push({ level: 'info', code: 'skipped', message: `表存在性/collation 预检跳过：${err.message}` });
  }
  let dbCollation = null;
  try {
    const r = await pool.query('SELECT @@collation_database AS c');
    dbCollation = String(r.rows?.[0]?.[0] ?? '');
  } catch { /* collation 探查失败不影响其余检查 */ }

  for (const t of targetTables) {
    if (!dbTables.has(t) && !createdInScript.has(t)) {
      items.push({ level: 'warn', code: 'table_missing', message: `目标表 ${t} 不存在（脚本内亦无先前 CREATE）——执行将失败` });
    } else if (dbCollation && dbTables.has(t) && dbTables.get(t) !== dbCollation) {
      items.push({ level: 'warn', code: 'collation_mismatch',
        message: `表 ${t} collation=${dbTables.get(t)} 与库默认 ${dbCollation} 不一致——过程/变量比较可能报 Illegal mix of collations，建议脚本显式 SET NAMES` });
    }
  }

  if (Date.now() - started > PRECHECK_BUDGET_MS) {
    items.push({ level: 'info', code: 'skipped', message: '预检超时（30s）——列匹配与唯一键预演跳过' });
    return { supported: true, items };
  }

  // 检查 2：INSERT 列匹配
  const colMap = new Map();
  const needCols = [...new Set(insertInfos.filter((x) => x.info.columns).map((x) => x.info.table))];
  if (needCols.length > 0) {
    try {
      const r = await pool.query(
        `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${needCols.map((t) => `'${t}'`).join(', ')})`);
      for (const row of r.rows ?? []) {
        if (!colMap.has(String(row[0]))) colMap.set(String(row[0]), new Set());
        colMap.get(String(row[0])).add(String(row[1]).toLowerCase());
      }
      for (const { info, line } of insertInfos) {
        if (!info.columns || !colMap.has(info.table)) continue;
        const actual = colMap.get(info.table);
        const unknown = info.columns.filter((c) => !actual.has(c.toLowerCase()));
        const missing = [...actual].filter((c) => !info.columns.map((x) => x.toLowerCase()).includes(c));
        if (unknown.length > 0 || missing.length > 0) {
          items.push({ level: 'warn', code: 'column_mismatch',
            message: `第 ${line} 行 INSERT INTO ${info.table} 列不匹配${unknown.length ? `：未知列 ${unknown.join(', ')}` : ''}${missing.length ? `；缺列 ${missing.join(', ')}` : ''}` });
        }
      }
    } catch (err) {
      items.push({ level: 'info', code: 'skipped', message: `列匹配预检跳过：${err.message}` });
    }
  }

  // 检查 3：UK/PK 冲突预演（仅全 UK 列字面量齐备者；提取不出静默跳过不误报）
  // INDEX_NAME 全库可重名——逐表查询 STATISTICS 按表建唯一键组
  const ukGroupsCache = new Map();
  async function ukGroupsOf(table) {
    if (ukGroupsCache.has(table)) return ukGroupsCache.get(table);
    let groups = null;
    try {
      const r = await pool.query(
        `SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}'`);
      groups = new Map();
      for (const row of r.rows ?? []) {
        if (Number(row[2]) !== 0) continue; // 只看唯一索引（含 PRIMARY）
        const idxName = String(row[0]);
        if (!groups.has(idxName)) groups.set(idxName, []);
        groups.get(idxName).push(String(row[1]).toLowerCase());
      }
    } catch { groups = null; } // 查询失败 → 该表跳过（不误报）
    ukGroupsCache.set(table, groups);
    return groups;
  }

  for (const { info, line } of insertInfos) {
    if (Date.now() - started > PRECHECK_BUDGET_MS) {
      items.push({ level: 'info', code: 'skipped', message: '预检超时（30s）——后续唯一键预演跳过' });
      break;
    }
    if (!info.columns || !info.literals) continue;
    const groups = await ukGroupsOf(info.table);
    if (!groups || groups.size === 0) continue;
    const colLower = info.columns.map((c) => c.toLowerCase());
    for (const [, ukCols] of groups) {
      const positions = ukCols.map((uc) => colLower.indexOf(uc));
      if (positions.some((p) => p < 0)) continue;
      const lits = positions.map((p) => info.literals[p]);
      if (lits.some((l) => l === null || /^null$/i.test(l))) continue; // 字面量不齐 → 静默跳过
      const where = ukCols.map((uc, i) => `${uc} = ${sqlLit(lits[i])}`).join(' AND ');
      try {
        const r = await pool.query(`SELECT COUNT(*) FROM \`${info.table}\` WHERE ${where}`);
        const n = Number(r.rows?.[0]?.[0] ?? 0);
        if (n > 0) {
          items.push({ level: 'high', code: 'uk_conflict',
            message: `第 ${line} 行 INSERT INTO ${info.table} 与已存在记录冲突（唯一键 ${ukCols.join('+')} 已有 ${n} 行匹配）——存储过程内冲突将回滚并写失败日志` });
        }
      } catch (err) {
        items.push({ level: 'info', code: 'skipped', message: `${info.table} 唯一键预演跳过：${err.message}` });
      }
    }
  }

  return { supported: true, items };
}

module.exports = { runPrecheck, extractInsertInfo };
