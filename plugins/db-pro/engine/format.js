'use strict';
// LLM 友好固定宽文本表（tools 层 query 结果渲染）。单元格 48 字符截断。

const MAX_CELL = 48;

function formatTable(columns, rows, note) {
  const sample = rows.slice(0, 50);
  const widths = columns.map((c, i) => {
    const longest = sample.reduce((m, r) => Math.max(m, String(r[i] ?? 'NULL').length), 0);
    return Math.min(MAX_CELL, Math.max(String(c).length, longest));
  });
  const line = (cells) => cells.map((c, i) => String(c ?? 'NULL').slice(0, widths[i]).padEnd(widths[i])).join(' | ');
  const out = [line(columns), widths.map((w) => '-'.repeat(w)).join('-+-')];
  for (const r of rows) out.push(line(r).trimEnd());
  if (note) out.push(String(note));
  return out.join('\n');
}

module.exports = { formatTable };
