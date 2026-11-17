'use strict';
// 配置 → 连接定义（spec §4.3 槽位制：conn1..conn6）+ diff 判定（顺序不敏感）。
const SLOT_COUNT = 6;

function connectionsFromConfig(config) {
  const conns = [];
  const seen = new Set();
  for (let i = 1; i <= SLOT_COUNT; i++) {
    const urlRaw = config[`conn${i}_url`];
    const url = typeof urlRaw === 'string' ? urlRaw.trim() : '';
    if (url === '') continue;
    const nameRaw = config[`conn${i}_name`];
    const name = typeof nameRaw === 'string' && nameRaw.trim() !== '' ? nameRaw.trim() : `conn${i}`;
    if (seen.has(name)) throw new Error(`连接名重复: "${name}"（conn${i}）——请为每个槽位设置唯一 name`);
    seen.add(name);
    conns.push({ name, url, queryTimeoutMs: Number(config.query_timeout_ms) || 30_000 });
  }
  return conns;
}

/** 有变化返回 true（按名比对 url/timeout；数量不等即变） */
function diffConnections(prev, next) {
  if (prev.length !== next.length) return true;
  const byName = new Map(prev.map((c) => [c.name, c]));
  for (const n of next) {
    const p = byName.get(n.name);
    if (!p || p.url !== n.url || p.queryTimeoutMs !== n.queryTimeoutMs) return true;
  }
  return false;
}

module.exports = { connectionsFromConfig, diffConnections, SLOT_COUNT };
