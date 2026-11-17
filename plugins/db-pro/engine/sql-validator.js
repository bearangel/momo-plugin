'use strict';
// 只读 SQL 校验器（spec §6.1）——引擎层纵深防御，不信任 LLM 遵守工具描述。
// 策略：剥离字面量/注释 → 禁分号（多语句）→ 拒锁子句/OUTFILE（全文检测，
// 接受误杀）→ 首词白名单 → SELECT/WITH 主语句的外层写关键词检测
// （SHOW CREATE TABLE 等只读前缀语句不检测——防误杀）。
// 误杀面由剥离步骤消除；仍误杀的合法 SQL 接受并引导改写（spec R4）。

const READ_FIRST_WORDS = new Set(['select', 'show', 'describe', 'desc', 'explain', 'with']);
/** 锁定与文件导出/重定向子句：全文检测（含子查询内——误杀可接受，spec R4）。
 *  普通 INTO 一并禁（终审 C1：PG SELECT INTO 建表 / 数据修改 CTE 的重定向通道）；
 *  MySQL INTO @var 会话变量属写侧语义，误杀可接受（R4） */
const DENY_CLAUSES = /\bfor\s+update\b|\bfor\s+share\b|\block\s+in\s+share\s+mode\b|\binto\b/i;
/** 外层写关键词（仅 SELECT/WITH 主语句检测——SHOW CREATE TABLE 等不误杀） */
const WRITE_KEYWORDS = /\b(insert|update|delete|merge|create|drop|alter|truncate|rename|grant|revoke|call|exec|execute|lock|load|set|vacuum|analyze|comment|audit|flashback|purge|shutdown|commit|rollback|savepoint)\b/i;

/** 剥离字符串字面量（'…"…`，双写转义）与注释（-- / # / 块），占位为空格 */
function stripLiteralsAndComments(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i += 1;
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { i += 2; continue; } // 双写转义
          i += 1;
          break;
        }
        i += 1;
      }
      out += ' ';
      continue;
    }
    if (two === '--' || c === '#') {
      while (i < n && sql[i] !== '\n') i += 1;
      continue;
    }
    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      out += ' ';
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 括号深度 0 的骨架（子查询/函数体挖空） */
function outerSkeleton(stripped) {
  let out = '';
  let depth = 0;
  for (const c of stripped) {
    if (c === '(') { depth += 1; out += ' '; continue; }
    if (c === ')') { depth = Math.max(0, depth - 1); out += ' '; continue; }
    out += depth === 0 ? c : ' ';
  }
  return out;
}

function firstWordOf(skeleton) {
  return (skeleton.trim().match(/^[a-zA-Z]+/) ?? [''])[0].toLowerCase();
}

/** 只读校验：通过 {ok:true}；拒绝 {ok:false, reason}（人话 + 改正指引） */
function assertReadOnly(sqlRaw) {
  if (typeof sqlRaw !== 'string' || sqlRaw.trim() === '') return { ok: false, reason: 'SQL 为空' };
  const stripped = stripLiteralsAndComments(sqlRaw);
  if (stripped.includes(';')) {
    return { ok: false, reason: '拒绝多语句（检测到分号）。请每次只执行一条语句。' };
  }
  if (DENY_CLAUSES.test(stripped)) {
    return { ok: false, reason: '拒绝锁定/导出子句（FOR UPDATE / FOR SHARE / LOCK IN SHARE MODE / INTO OUTFILE）。' };
  }
  const skeleton = outerSkeleton(stripped);
  const firstWord = firstWordOf(skeleton);
  if (!READ_FIRST_WORDS.has(firstWord)) {
    return { ok: false, reason: `首词 "${firstWord || '(空)'}" 不在只读白名单（SELECT/SHOW/DESCRIBE/EXPLAIN/WITH）。写操作请使用 write 工具发起人工批准。` };
  }
  if (firstWord === 'select' || firstWord === 'with') {
    // 终审 C1：全文检测（stripped——字面量/注释已剥离）而非骨架——括号内
    //（子查询/CTE 体）的写词不再被挖空放过；引号标识符经剥离不受误杀（R4 兜底）
    const m = stripped.match(WRITE_KEYWORDS);
    if (m) {
      return { ok: false, reason: `语句包含写关键词 "${m[0].toUpperCase()}"。写操作请使用 write 工具发起人工批准。` };
    }
  }
  return { ok: true };
}

/** 写操作分类（service write 前置，spec §5.2） */
function classifyWrite(sqlRaw) {
  if (typeof sqlRaw !== 'string' || sqlRaw.trim() === '') return { opClass: 'REJECT', reason: 'SQL 为空' };
  const stripped = stripLiteralsAndComments(sqlRaw);
  if (stripped.includes(';')) return { opClass: 'REJECT', reason: '拒绝多语句——每次一条' };
  const firstWord = firstWordOf(outerSkeleton(stripped));
  if (['insert', 'update', 'delete', 'merge'].includes(firstWord)) return { opClass: 'DML' };
  if (['create', 'drop', 'alter', 'truncate', 'rename', 'comment'].includes(firstWord)) return { opClass: 'DDL' };
  return { opClass: 'REJECT', reason: `不支持的写操作首词 "${firstWord}"` };
}

module.exports = { assertReadOnly, classifyWrite, stripLiteralsAndComments, outerSkeleton };
