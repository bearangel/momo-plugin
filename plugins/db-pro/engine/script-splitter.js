'use strict';
// 通用 SQL 脚本切分器（spec 2026-11-19 §5.2）：引擎中立 tokenizer + 每库 profile。
// 纯函数模块——不依赖驱动/协议；engine（执行）与 service（dry-run/审批摘要）共用。

class SplitterError extends Error {
  constructor(message, line) {
    super(message);
    this.name = 'SplitterError';
    this.line = line;
  }
}

const DIALECTS = new Set(['mysql', 'postgres', 'postgresql', 'oracle', 'dm', 'dameng']);

function normalizeDialect(raw) {
  const d = String(raw ?? 'mysql');
  if (d === 'postgresql') return 'postgres';
  if (d === 'dameng') return 'dm';
  if (!DIALECTS.has(d)) throw new SplitterError(`不支持的脚本方言 "${d}"`, 1);
  return d;
}

function firstKeyword(text) {
  const m = String(text).trim().match(/^[A-Za-z]+/);
  return m ? m[0].toLowerCase() : '';
}

const TABLE_PATTERNS = [
  /\b(?:insert\s+into|replace\s+into|merge\s+into)\s+([A-Za-z0-9_$."`[\]]+)/i,
  /\bupdate\s+([A-Za-z0-9_$."`[\]]+)/i,
  /\bdelete\s+from\s+([A-Za-z0-9_$."`[\]]+)/i,
  /\btruncate\s+table\s+([A-Za-z0-9_$."`[\]]+)/i,
  /\b(?:create|drop|alter)\s+table\s+(?:if\s+(?:not\s+)?exists\s+)?([A-Za-z0-9_$."`[\]]+)/i,
  /\bcreate\s+(?:unique\s+)?index\s+\S+\s+on\s+([A-Za-z0-9_$."`[\]]+)/i,
];

function inferTables(text) {
  const out = [];
  for (const re of TABLE_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const name = m[1].replace(/["`[\]]/g, '').split('.').pop();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

function classifyStatement(textRaw) {
  const text = String(textRaw ?? '');
  const first = firstKeyword(text);
  const second = (text.trim().match(/^[A-Za-z]+\s+(?:or\s+replace\s+)?([A-Za-z]+)/i) ?? [])[1]?.toLowerCase() ?? '';
  let cls = 'unknown';
  if (['select', 'show', 'desc', 'describe', 'explain', 'with'].includes(first)) cls = 'read';
  else if (first === 'insert') cls = 'insert';
  else if (first === 'update') cls = 'update';
  else if (first === 'delete') cls = 'delete';
  else if (first === 'merge') cls = 'merge';
  else if (first === 'truncate') cls = 'ddl_table';
  else if (first === 'create' || first === 'drop' || first === 'alter') {
    if (second === 'table') cls = 'ddl_table';
    else if (['procedure', 'function', 'package', 'trigger'].includes(second)) cls = 'procedure';
    else if (['view', 'index', 'sequence', 'trigger'].includes(second)) cls = 'ddl_other';
    else cls = 'ddl_other';
  } else if (first === 'call' || first === 'exec' || first === 'execute') cls = 'procedure';
  else if (first === 'set' || first === 'use') cls = 'session';
  else if (['start', 'commit', 'rollback', 'savepoint'].includes(first)) cls = 'txn';
  else if (first === 'begin' || first === 'declare') cls = 'block';
  else if (first === 'grant' || first === 'revoke') cls = 'priv';
  return { cls, tables: inferTables(text) };
}

function splitStatements(scriptRaw, dialectRaw) {
  const dialect = normalizeDialect(dialectRaw);
  const src = String(scriptRaw ?? '');
  const statements = [];
  const warnings = [];
  let buf = '';
  let line = 1;
  let stmtLine = 1;
  let quote = null; // ' | " | `
  let blockComment = false;
  let lineComment = false;
  let atLineStart = true;
  let terminator = ';';
  let dollarTag = null;
  const isPlsql = dialect === 'oracle' || dialect === 'dm';
  let depth = 0;
  let skipEndQualifier = false;
  let blockMode = false;
  let blockStarted = false;

  function handlePlsqlWord(word) {
    const w = word.toLowerCase();
    if (skipEndQualifier && (w === 'if' || w === 'loop' || w === 'case')) {
      skipEndQualifier = false;
      return;
    }
    if (w === 'end') { depth = Math.max(0, depth - 1); skipEndQualifier = true; return; }
    if (w === 'begin' || w === 'loop' || w === 'case' || w === 'if') depth += 1;
  }

  function flush() {
    const text = buf.trim();
    buf = '';
    skipEndQualifier = false;
    blockMode = false;
    blockStarted = false;
    pushStatement(text, stmtLine);
  }

  function pushStatement(text, atLine) {
    const t = String(text).trim();
    if (t === '') return;
    const { cls, tables } = classifyStatement(t);
    statements.push({ idx: statements.length + 1, line: atLine, text: t, keyword: firstKeyword(t), cls, tables });
  }

  // MySQL 客户端指令（spec §5.2）：独立成行且当前缓冲无实质内容才识别
  function tryDelimiterDirective(at) {
    if (dialect !== 'mysql' || !atLineStart || buf.trim() !== '') return -1;
    const m = src.slice(at).match(/^delimiter[ \t]+(\S+)[ \t]*\r?\n?/i);
    if (!m) return -1;
    terminator = m[1];
    return at + m[0].length - 1;
  }

  function markStartIfNeeded(c) {
    if (buf.trim() === '' && !/\s/.test(c)) stmtLine = line;
  }

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '\n') {
      buf += c;
      line += 1;
      atLineStart = true;
      lineComment = false;
      continue;
    }

    if (atLineStart && buf.trim() === '') {
      const skipTo = tryDelimiterDirective(i);
      if (skipTo >= 0) {
        const consumed = src.slice(i, skipTo + 1);
        line += (consumed.match(/\n/g) ?? []).length;
        i = skipTo;
        atLineStart = true;
        continue;
      }
    }

    if (isPlsql && quote === null && !blockComment && !lineComment && atLineStart && buf.trim() === '') {
      const rest = src.slice(i);
      const filtered = rest.match(/^(set|prompt|show|clear|define|undefine|spool)\b[^\n]*\r?\n?/i);
      if (filtered) {
        warnings.push({ line, type: 'filtered_directive', message: `已忽略 SQL*Plus 指令：${filtered[0].trim()}` });
        line += (filtered[0].match(/\n/g) ?? []).length;
        i += filtered[0].length - 1;
        atLineStart = true;
        continue;
      }
      const rejected = rest.match(/^(exit|quit|whenever|host|start|@@?)\b/i);
      if (rejected) {
        throw new SplitterError(`第 ${line} 行：不支持控制流/包含指令 "${rejected[1].toUpperCase()}"——请内联脚本内容并移除该指令`, line);
      }
      const slash = rest.match(/^\/[ \t]*\r?\n?/);
      if (slash) {
        flush();
        line += (slash[0].match(/\n/g) ?? []).length;
        i += slash[0].length - 1;
        atLineStart = true;
        continue;
      }
      const execLine = rest.match(/^(exec|execute)[ \t]+[^\n]*/i);
      if (execLine) {
        const text = execLine[0].replace(/;\s*$/, '').trim();
        pushStatement(text, line);
        i += execLine[0].length - 1;
        atLineStart = false;
        continue;
      }
    }

    if (quote === null && !blockComment && !lineComment && dollarTag === null) {
      if (dialect === 'postgres' && atLineStart && buf.trim() === '' && c === '\\') {
        throw new SplitterError(`第 ${line} 行：不支持 psql 元命令（\\...）——请将目标文件内容内联为 SQL`, line);
      }
      if (dialect === 'postgres' && c === '$') {
        const m = src.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
        if (m) {
          dollarTag = m[0];
          buf += m[0];
          i += m[0].length - 1;
          atLineStart = false;
          continue;
        }
      }
      markStartIfNeeded(c);
      // 行注释（-- 后须空白/行尾；MySQL 语法）与 MySQL # 注释——内容不入语句文本
      if (c === '-' && next === '-') {
        const after = src[i + 2];
        if (after === undefined || /\s/.test(after)) {
          lineComment = true;
          buf += ' ';
          i += 1;
          continue;
        }
      }
      if (dialect === 'mysql' && c === '#') {
        lineComment = true;
        buf += ' ';
        continue;
      }
      if (c === '/' && next === '*') {
        blockComment = true;
        buf += ' ';
        i += 1;
        continue;
      }
    }

    if (lineComment) { continue; }

    if (blockComment) {
      if (c === '*' && next === '/') { i += 1; blockComment = false; }
      continue;
    }

    if (dollarTag !== null) {
      if (src.startsWith(dollarTag, i)) {
        buf += dollarTag;
        i += dollarTag.length - 1;
        dollarTag = null;
        atLineStart = false;
        continue;
      }
      buf += c;
      atLineStart = false;
      continue;
    }

    if (quote !== null) {
      buf += c;
      if (dialect === 'mysql' && c === '\\' && quote !== '`') {
        if (next !== undefined) { buf += next; i += 1; }
        continue;
      }
      if (c === quote) {
        if (next === quote) { buf += next; i += 1; continue; } // 双写转义
        quote = null;
      }
      continue;
    }

    if (c === "'" || c === '"' || (dialect === 'mysql' && c === '`')) {
      quote = c;
      buf += c;
      atLineStart = false;
      continue;
    }

    if (isPlsql && /[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z_]/.test(src[j])) j += 1;
      const word = src.slice(i, j);
      markStartIfNeeded(c);
      if (buf.trim() === '' && /^(begin|declare)$/i.test(word)) blockMode = true;
      if (blockMode && /^begin$/i.test(word)) blockStarted = true;
      if (/^(procedure|function|trigger|package|type)$/i.test(word) && /^create\b/i.test(buf.trim())) blockMode = true;
      if (blockMode) handlePlsqlWord(word);
      buf += word;
      i = j - 1;
      atLineStart = false;
      continue;
    }

    if (isPlsql && c === ';' && blockMode && (depth > 0 || !blockStarted)) {
      buf += c;
      atLineStart = false;
      continue;
    }

    if (src.startsWith(terminator, i)) {
      flush();
      i += terminator.length - 1;
      atLineStart = false;
      continue;
    }

    buf += c;
    atLineStart = false;
  }

  if (quote !== null) throw new SplitterError(`第 ${line} 行：${quote} 引号未闭合`, line);
  if (blockComment) throw new SplitterError(`第 ${line} 行：块注释未闭合`, line);
  if (dollarTag !== null) throw new SplitterError(`第 ${line} 行：美元引用 ${dollarTag} 未闭合`, line);
  flush();
  for (const s of statements) {
    if (isPlsql && (s.keyword === 'exec' || s.keyword === 'execute')) {
      const expr = s.text.replace(/^(exec|execute)\s+/i, '');
      s.text = `BEGIN ${expr}; END`;
      s.keyword = 'begin';
      const { cls, tables } = classifyStatement(s.text);
      s.cls = cls;
      s.tables = tables;
    }
  }
  return { statements, warnings };
}

function summarize(statements) {
  const counts = {};
  const tables = [];
  for (const s of statements) {
    const cls = s.cls ?? 'unknown';
    counts[cls] = (counts[cls] ?? 0) + 1;
    for (const t of s.tables ?? []) if (!tables.includes(t)) tables.push(t);
  }
  return { statementCount: statements.length, counts, tables };
}

function extractScriptNo(scriptRaw) {
  const m = String(scriptRaw ?? '').match(/@__script_no\s*=\s*'([^']+)'/i)
    ?? String(scriptRaw ?? '').match(/SCRIPT_NO\s*[:=]\s*([A-Za-z0-9_.-]+)/i);
  return m ? m[1] : null;
}

// 模板缺陷检测（spec 2026-11-20 §6 附带）：EXIT HANDLER 内 ROLLBACK 先于
// GET DIAGNOSTICS——MySQL 的 ROLLBACK 会清空诊断区，真实错误被吞成
// [?] Unknown error（DAP-E 模板实证）。MySQL 语法启发式：仅扫 procedure
// 语句文本，命中即告警（非阻断，dryrun 呈现）。
function detectTemplateIssues(statements) {
  const issues = [];
  for (const s of statements ?? []) {
    if (s.cls !== 'procedure' || !/CREATE\s+PROCEDURE/i.test(s.text)) continue;
    const m = s.text.match(/EXIT\s+HANDLER[^;]*\sBEGIN([\s\S]*?)\bEND/si);
    if (!m) continue;
    const body = m[1];
    const rb = body.search(/\bROLLBACK\b/i);
    const gd = body.search(/\bGET\s+DIAGNOSTICS\b/i);
    if (rb >= 0 && gd >= 0 && rb < gd) {
      issues.push({
        line: s.line,
        type: 'handler_order',
        message: `第 ${s.line} 行存储过程 EXIT HANDLER 内 ROLLBACK 先于 GET DIAGNOSTICS——回滚会清空诊断区吞错（真实错误变 [?] Unknown error）。建议模板改为先取诊断再回滚。`,
      });
    }
  }
  return issues;
}

module.exports = { splitStatements, summarize, extractScriptNo, firstKeyword, classifyStatement, inferTables, SplitterError, detectTemplateIssues };
