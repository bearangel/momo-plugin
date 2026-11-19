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

  function flush() {
    const text = buf.trim();
    buf = '';
    if (text !== '') {
      statements.push({ idx: statements.length + 1, line: stmtLine, text, keyword: firstKeyword(text) });
    }
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

module.exports = { splitStatements, summarize, extractScriptNo, firstKeyword, SplitterError };
