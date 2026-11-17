'use strict';
// 写两段式状态机（spec §5.2 / §4.2）：write → human_requests(tool_gate, db 载荷)
// → writeStatus 轮询 → approved 才执行。幂等保护（spec D7）：执行记录追加
// write-log.jsonl（进程重启后重建内存 Map）——同一 requestId 至多执行一次，
// 宁可 replayed 返回缓存结果，绝不重复执行写。
const fs = require('node:fs');
const path = require('node:path');
const { classifyWrite } = require('../engine/sql-validator');

const WRITE_LOG = 'write-log.jsonl';

function readLogEntries(dataDir) {
  try {
    return fs.readFileSync(path.join(dataDir, WRITE_LOG), 'utf-8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function createWriteState({ humanGate, execSql, dataDir, log }) {
  const writeLogPath = path.join(dataDir, WRITE_LOG);
  const executed = new Map(readLogEntries(dataDir).map((e) => [e.requestId, e]));

  function appendLog(entry) {
    try {
      fs.appendFileSync(writeLogPath, JSON.stringify(entry) + '\n');
    } catch (err) {
      log('db-pro 写日志追加失败（幂等保护降级为内存态）', { error: err.message });
    }
  }

  async function request(p) {
    const sql = typeof p.sql === 'string' ? p.sql : '';
    const connection = typeof p.connection === 'string' && p.connection !== '' ? p.connection : '';
    if (connection === '') throw new Error('write 须指定 connection');
    if (typeof p.sessionId !== 'string' || p.sessionId === '') {
      throw new Error('write 缺少 sessionId（工具层注入失败——面板将不可见）');
    }
    const { opClass, reason } = classifyWrite(sql);
    if (opClass === 'REJECT') throw new Error(`写请求被拒绝：${reason}`);
    const id = await humanGate().create({
      sessionId: p.sessionId,
      taskId: typeof p.taskId === 'string' ? p.taskId : null,
      title: `数据库写请求（${opClass}）`,
      payloadJson: JSON.stringify({ db: { connection, sql, opClass } }),
    });
    return { requestId: id, status: 'pending' };
  }

  async function status(p) {
    const requestId = String(p.requestId ?? '');
    if (requestId === '') throw new Error('writeStatus 缺少 requestId');
    const row = await humanGate().status(requestId);
    if (!row) return { status: 'not_found' };
    if (row.status !== 'answered') return { status: row.status };
    let answer = null;
    try { answer = row.answerJson ? JSON.parse(row.answerJson) : null; } catch { answer = null; }
    if (answer?.decision === 'deny') {
      return { status: 'denied', note: typeof answer.text === 'string' ? answer.text : '' };
    }
    if (answer?.decision !== 'approve') {
      return { status: 'unknown', note: `意外答复形态: ${row.answerJson ?? '（空）'}` };
    }
    if (executed.has(requestId)) {
      return { status: 'executed', affectedRows: executed.get(requestId).affectedRows, replayed: true };
    }
    let payload = null;
    try { payload = row.payloadJson ? JSON.parse(row.payloadJson).db : null; } catch { payload = null; }
    if (!payload || typeof payload.sql !== 'string' || typeof payload.connection !== 'string') {
      return { status: 'invalid_payload' };
    }
    const r = await execSql(payload.connection, payload.sql);
    const entry = { requestId, affectedRows: r.affectedRows, at: Date.now() };
    executed.set(requestId, entry);
    appendLog(entry);
    return { status: 'executed', affectedRows: r.affectedRows };
  }

  return { request, status };
}

module.exports = { createWriteState };
