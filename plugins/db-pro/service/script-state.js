'use strict';
// 脚本执行编排（spec 2026-11-19 §5.1/§5.4/§5.5，D13）：submit → human_requests
// tool_gate 行 → status 轮询 → approve 启动后台作业（不阻塞轮询）→ 结果缓存 +
// 历史落账。重放保护（同 write-state D7）：同一 requestId 至多执行一次；
// 执行中断（尝试中无结果）返回 exec_unknown，绝不重跑。
const fs = require('node:fs');
const path = require('node:path');

const HISTORY_FILE = 'script-history.jsonl';
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_STATEMENTS = 10_000;
const HISTORY_MAX_BYTES = 5 * 1024 * 1024;
const HISTORY_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function readEntries(file) {
  try {
    return fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim() !== '')
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

function createScriptState({ humanGate, analyze, run, dataDir, log }) {
  const file = path.join(dataDir, HISTORY_FILE);
  const records = new Map(readEntries(file).map((e) => [e.requestId, e]));
  const jobs = new Map();

  function append(entry) {
    try { fs.appendFileSync(file, JSON.stringify(entry) + '\n'); } catch (err) {
      log('db-pro 脚本历史追加失败（重放保护降级为内存态）', { error: err.message });
    }
    records.set(entry.requestId, entry);
    rotate();
  }

  function rotate() {
    try {
      const st = fs.statSync(file);
      if (st.size <= HISTORY_MAX_BYTES) return;
      const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
      const keep = readEntries(file).filter((e) => e.status === 'attempting' || (e.at ?? 0) >= cutoff);
      fs.writeFileSync(file, keep.map((e) => JSON.stringify(e)).join('\n') + (keep.length ? '\n' : ''));
    } catch { /* 轮转失败不影响主路径 */ }
  }

  async function submit(p) {
    const connection = typeof p.connection === 'string' && p.connection !== '' ? p.connection : '';
    if (connection === '') throw new Error('script_execute 须指定 connection');
    if (typeof p.sessionId !== 'string' || p.sessionId === '') {
      throw new Error('script_execute 缺少 sessionId（工具层注入失败——面板将不可见）');
    }
    const script = typeof p.script === 'string' ? p.script : '';
    if (Buffer.byteLength(script, 'utf-8') > MAX_SCRIPT_BYTES) throw new Error('脚本超过 2MB 上限——请拆分后分批执行');
    const analysis = await analyze(connection, script);
    if ((analysis.statements?.length ?? 0) > MAX_STATEMENTS) {
      throw new Error(`脚本语句数超过 ${MAX_STATEMENTS} 条上限——请拆分后分批执行`);
    }
    if (analysis.statements?.length === 0) {
      return { dryrun: p.dryrun === true, statements: [], warnings: analysis.warnings ?? [], summary: analysis.summary, scriptNo: analysis.scriptNo, note: '0 条语句（空脚本/纯注释/纯客户端指令）' };
    }
    if (p.dryrun === true) {
      return { dryrun: true, statements: analysis.statements, warnings: analysis.warnings, summary: analysis.summary, scriptNo: analysis.scriptNo };
    }
    const onError = p.onError === 'continue' ? 'continue' : 'abort';
    const counts = analysis.summary?.counts ?? {};
    const countText = Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(' · ');
    const tables = analysis.summary?.tables ?? [];
    const risk = [];
    const ddl = (counts.ddl_table ?? 0) + (counts.ddl_other ?? 0);
    if (ddl > 0) risk.push(`DDL×${ddl}`);
    if ((counts.merge ?? 0) > 0) risk.push(`MERGE×${counts.merge}`);
    const head = script.split('\n').slice(0, 20).join('\n');
    const id = await humanGate().create({
      sessionId: p.sessionId,
      taskId: typeof p.taskId === 'string' ? p.taskId : null,
      title: `脚本执行：${analysis.scriptNo ?? '未识别'} · ${connection} · ${analysis.statements.length} 语句`,
      prompt: [
        `分类：${countText || '（无）'}`,
        tables.length > 0 ? `目标表（推断）：${tables.join(', ')}` : '目标表（推断）：无',
        risk.length > 0 ? `风险：${risk.join(' · ')}` : '风险：无 DDL/MERGE',
        `失败策略：${onError === 'abort' ? '失败即停' : '继续执行'}`,
        `脚本头部预览：\n${head}`,
      ].join('\n'),
      payloadJson: JSON.stringify({
        db: { kind: 'script', connection, sql: head, opClass: 'script', script, onError, summary: analysis.summary, scriptNo: analysis.scriptNo },
      }),
    });
    return { requestId: id, status: 'pending', summary: analysis.summary, scriptNo: analysis.scriptNo };
  }

  async function status(p) {
    const requestId = String(p.requestId ?? '');
    if (requestId === '') throw new Error('script_status 缺少 requestId');
    const row = await humanGate().status(requestId);
    if (!row) return { status: 'not_found' };
    if (row.status !== 'answered') return { status: row.status };

    let answer = null;
    try { answer = row.answerJson ? JSON.parse(row.answerJson) : null; } catch { answer = null; }
    if (answer?.decision === 'deny') {
      if (records.get(requestId)?.status !== 'denied') append({ requestId, status: 'denied', at: Date.now() });
      return { status: 'denied', note: typeof answer.text === 'string' ? answer.text : '' };
    }
    if (answer?.decision !== 'approve') return { status: 'unknown', note: `意外答复形态: ${row.answerJson ?? '（空）'}` };

    const prior = records.get(requestId);
    if (prior?.status === 'attempting' && !jobs.has(requestId)) {
      return { status: 'exec_unknown', note: '此前执行中断（超时/引擎崩溃），结果未知——请人工核查数据库实际状态后重新发起' };
    }
    if (prior && prior.status !== 'attempting') {
      return { status: 'executed', result: prior.result, replayed: true };
    }

    let job = jobs.get(requestId);
    if (!job) {
      let payload = null;
      try { payload = row.payloadJson ? JSON.parse(row.payloadJson).db : null; } catch { payload = null; }
      if (!payload || payload.kind !== 'script' || typeof payload.script !== 'string' || typeof payload.connection !== 'string') {
        return { status: 'invalid_payload' };
      }
      append({ requestId, status: 'attempting', at: Date.now(), connection: payload.connection, scriptNo: payload.scriptNo ?? null });
      const started = Date.now();
      const promise = Promise.resolve()
        .then(() => run(payload))
        .then((result) => {
          append({
            requestId, status: result.ok ? 'executed' : 'failed', at: Date.now(),
            connection: payload.connection, scriptNo: payload.scriptNo ?? null,
            statementCount: result.total, executed: result.executed,
            failedAtIndex: result.failedAtIndex ?? null,
            errorSummary: result.error?.message ?? null,
            durationMs: result.durationMs, tables: payload.summary?.tables ?? [],
            result,
          });
          jobs.set(requestId, { state: 'done', result });
          return result;
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          const result = { ok: false, total: 0, executed: 0, error: { code: 'service_error', message }, durationMs: Date.now() - started };
          append({
            requestId, status: 'failed', at: Date.now(), connection: payload.connection,
            scriptNo: payload.scriptNo ?? null, errorSummary: message, durationMs: result.durationMs, result,
          });
          jobs.set(requestId, { state: 'done', result });
          return result;
        });
      job = { state: 'running', promise };
      jobs.set(requestId, job);
      void promise;
    }
    if (jobs.get(requestId).state === 'done') {
      return { status: 'executed', result: jobs.get(requestId).result };
    }
    return { status: 'running' };
  }

  async function history(p) {
    const limit = Number.isFinite(p.limit) && p.limit > 0 ? Math.min(Math.floor(p.limit), 200) : 20;
    const connection = typeof p.connection === 'string' && p.connection !== '' ? p.connection : null;
    const entries = readEntries(file)
      .filter((e) => e.status !== 'attempting')
      .filter((e) => (connection === null ? true : e.connection === connection))
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      .slice(0, limit)
      .map((e) => ({
        requestId: e.requestId, at: e.at, connection: e.connection, scriptNo: e.scriptNo ?? null,
        result: e.status === 'executed' ? 'ok' : e.status === 'failed' ? 'failed' : e.status,
        statementCount: e.statementCount ?? null, failedAtIndex: e.failedAtIndex ?? null,
        errorSummary: e.errorSummary ?? null, durationMs: e.durationMs ?? null,
      }));
    return { entries };
  }

  return { submit, status, history };
}

module.exports = { createScriptState, MAX_SCRIPT_BYTES, MAX_STATEMENTS };
