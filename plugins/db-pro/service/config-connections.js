'use strict';
// 配置 → 连接定义（spec §4.3 槽位制：conn1..conn6）+ diff 判定（顺序不敏感）。
const SLOT_COUNT = 6;

/** 单查询超时净化：非有限数/负数/<1s 归缺省 30s，封顶 300s。
 *  实证（2026-11-18 用户实测）：-40 经 Number()||缺省 挡不住（truthy）直传
 *  mysql2 语句超时 → Node 负超时压 1ms → 全量查询瞬时超时 */
function sanitizeTimeoutMs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1_000) return 30_000;
  return Math.min(n, 300_000);
}

function connectionsFromConfig(config) {
  const conns = [];
  const seen = new Set();
  const queryTimeoutMs = sanitizeTimeoutMs(config.query_timeout_ms);
  for (let i = 1; i <= SLOT_COUNT; i++) {
    const urlRaw = config[`conn${i}_url`];
    const url = typeof urlRaw === 'string' ? urlRaw.trim() : '';
    if (url === '') continue;
    const nameRaw = config[`conn${i}_name`];
    const name = typeof nameRaw === 'string' && nameRaw.trim() !== '' ? nameRaw.trim() : `conn${i}`;
    if (seen.has(name)) throw new Error(`连接名重复: "${name}"（conn${i}）——请为每个槽位设置唯一 name`);
    seen.add(name);
    conns.push({ name, url, queryTimeoutMs });
  }
  return conns;
}

/** 整脚本超时净化：非有限/负数 → 缺省 600s；下限 10s；上限 3600s */
function sanitizeScriptTimeoutMs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 600_000;
  return Math.min(Math.max(n, 10_000), 3_600_000);
}

/** 有变化返回 true（按名比对 url/timeout；数量不等即变） */
function diffConnections(prev, next) {
  if (prev.length !== next.length) return true;
  const byName = new Map(prev.map((c) => [c.name, c]));
  for (const n of next) {
    const p = byName.get(n.name);
    if (!p || p.url !== n.url || p.queryTimeoutMs !== n.queryTimeoutMs) return true;
    if (JSON.stringify(p.permissions ?? null) !== JSON.stringify(n.permissions ?? null)) return true;
  }
  return false;
}

/** write 前置校验：连接名必须已配置——agent 可虚构名（stu 实证），不校验会
 *  「建卡获批→执行才炸」，批准流被打穿。未知名抛人话错误并列可用清单 */
function validateWriteConnection(conns, name) {
  if (!conns.some((c) => c.name === name)) {
    const list = conns.map((c) => c.name).join(', ') || '（无）';
    throw new Error(`未配置的连接 "${String(name)}"——可用连接: ${list}（list_connections 可查；未配置请在插件「数据库」面板添加）`);
  }
}

module.exports = { connectionsFromConfig, diffConnections, sanitizeTimeoutMs, sanitizeScriptTimeoutMs, validateWriteConnection, SLOT_COUNT };
