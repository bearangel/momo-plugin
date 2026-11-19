// tests/db-pro/script-state.test.mjs
// 脚本执行编排单测（spec 2026-11-19 §5.1/§5.4/§5.5，D13）：审批/后台作业/历史/重放保护。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import m from '../../plugins/db-pro/service/script-state.js';
import splitter from '../../plugins/db-pro/engine/script-splitter.js';
const { splitStatements, summarize, extractScriptNo } = splitter;
const { createScriptState } = m;

function makeDeps(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbpro-script-'));
  const rows = new Map();
  let n = 0;
  const gate = {
    async create(input) {
      n += 1;
      const id = `req-${n}`;
      rows.set(id, { id, status: 'pending', answerJson: null, payloadJson: input.payloadJson });
      gate.created.push(input);
      return id;
    },
    async status(id) { return rows.get(id) ?? null; },
    created: [],
  };
  const state = createScriptState({
    humanGate: () => gate,
    analyze: async () => ({
      statements: [
        { idx: 1, line: 1, text: "SET @__script_no = 'S1'", keyword: 'set', cls: 'session', tables: [] },
        { idx: 2, line: 2, text: 'INSERT INTO a VALUES (1)', keyword: 'insert', cls: 'insert', tables: ['a'] },
      ],
      warnings: [],
      summary: { statementCount: 2, counts: { session: 1, insert: 1 }, tables: ['a'] },
      scriptNo: 'S1',
    }),
    run: async () => ({ ok: true, total: 2, executed: 2, results: [], durationMs: 5 }),
    dataDir: dir,
    log: () => undefined,
    ...overrides,
  });
  return { state, gate, rows, dir };
}

describe('script-state · submit', () => {
  it('dryrun 直接返回分析，不建人工请求', async () => {
    const { state, gate } = makeDeps();
    const r = await state.submit({ connection: 'c', script: 'SELECT 1', sessionId: 's', dryrun: true });
    expect(r.dryrun).toBe(true);
    expect(r.scriptNo).toBe('S1');
    expect(gate.created).toHaveLength(0);
  });
  it('正常提交建 tool_gate 卡：标题带脚本号/语句数，payload 含 script 全文', async () => {
    const { state, gate } = makeDeps();
    const r = await state.submit({ connection: 'c', script: 'X', sessionId: 's' });
    expect(r).toEqual({ requestId: 'req-1', status: 'pending', summary: expect.any(Object), scriptNo: 'S1' });
    const card = gate.created[0];
    expect(card.title).toContain('S1');
    expect(card.title).toContain('2 语句');
    const payload = JSON.parse(card.payloadJson);
    expect(payload.db.kind).toBe('script');
    expect(payload.db.script).toBe('X');
    expect(payload.db.opClass).toBe('script');
  });
  it('缺少 sessionId / connection → 人话错误', async () => {
    const { state } = makeDeps();
    await expect(state.submit({ connection: 'c', script: 'X' })).rejects.toThrow(/sessionId/);
    await expect(state.submit({ connection: '', script: 'X', sessionId: 's' })).rejects.toThrow(/connection/);
  });
  it('脚本超 2MB 拒绝', async () => {
    const { state } = makeDeps();
    await expect(state.submit({ connection: 'c', script: 'x'.repeat(2 * 1024 * 1024 + 1), sessionId: 's' }))
      .rejects.toThrow(/2MB/);
  });
});

describe('script-state · status', () => {
  it('approve → 后台执行 → running → executed（至多执行一次）', async () => {
    let runs = 0;
    const { state, rows } = makeDeps({ run: async () => { runs += 1; return { ok: true, total: 2, executed: 2, results: [], durationMs: 1 }; } });
    const { requestId } = await state.submit({ connection: 'c', script: 'X', sessionId: 's' });
    rows.get(requestId).status = 'answered';
    rows.get(requestId).answerJson = JSON.stringify({ decision: 'approve' });
    const r1 = await state.status({ requestId });
    expect(['running', 'executed']).toContain(r1.status);
    let last = r1;
    for (let i = 0; i < 50 && last.status === 'running'; i += 1) {
      await new Promise((res) => setTimeout(res, 5));
      last = await state.status({ requestId });
    }
    expect(last.status).toBe('executed');
    const r3 = await state.status({ requestId });
    expect(r3.status).toBe('executed');
    expect(runs).toBe(1);
  });
  it('deny → denied 带附言', async () => {
    const { state, rows } = makeDeps();
    const { requestId } = await state.submit({ connection: 'c', script: 'X', sessionId: 's' });
    rows.get(requestId).status = 'answered';
    rows.get(requestId).answerJson = JSON.stringify({ decision: 'deny', text: '别跑' });
    expect(await state.status({ requestId })).toEqual({ status: 'denied', note: '别跑' });
  });
  it('执行失败 → 记录历史 failed', async () => {
    const { state, rows, dir } = makeDeps({ run: async () => ({ ok: false, total: 2, executed: 2, results: [], failedAtIndex: 2, error: { code: 'x', message: 'boom', line: 9 }, durationMs: 3 }) });
    const { requestId } = await state.submit({ connection: 'c', script: 'X', sessionId: 's' });
    rows.get(requestId).status = 'answered';
    rows.get(requestId).answerJson = JSON.stringify({ decision: 'approve' });
    await state.status({ requestId });
    for (let i = 0; i < 50; i += 1) {
      const r = await state.status({ requestId });
      if (r.status === 'executed' || r.status === 'failed') break;
      await new Promise((res) => setTimeout(res, 5));
    }
    const hist = await state.history({ limit: 10 });
    expect(hist.entries[0].result).toBe('failed');
    expect(fs.existsSync(path.join(dir, 'script-history.jsonl'))).toBe(true);
  });
  it('未知 requestId → not_found', async () => {
    const { state } = makeDeps();
    expect(await state.status({ requestId: 'nope' })).toEqual({ status: 'not_found' });
  });
});

describe('script-state · 作业异常路径（终审 Important）', () => {
  it('run 抛错 → 结果为 ok:false 且 total/executed 为 0（错误文案不出 undefined）', async () => {
    const { state, rows } = makeDeps({ run: async () => { throw new Error('engine crashed'); } });
    const { requestId } = await state.submit({ connection: 'c', script: 'X', sessionId: 's' });
    rows.get(requestId).status = 'answered';
    rows.get(requestId).answerJson = JSON.stringify({ decision: 'approve' });
    await state.status({ requestId });
    let last = null;
    for (let i = 0; i < 50; i += 1) {
      last = await state.status({ requestId });
      if (last.status === 'executed') break;
      await new Promise((res) => setTimeout(res, 5));
    }
    expect(last.status).toBe('executed');
    expect(last.result.ok).toBe(false);
    expect(last.result.total).toBe(0);
    expect(last.result.executed).toBe(0);
    expect(last.result.error.message).toContain('engine crashed');
  });
});

// 审批前权限预检（spec 2026-11-19 §6.4）：缺位在建卡前拒，dryrun 同样受检。
const realAnalyze = async (_connection, script) => {
  const r = splitStatements(script, 'mysql');
  return { statements: r.statements, warnings: r.warnings, summary: summarize(r.statements), scriptNo: extractScriptNo(script) };
};

describe('审批前权限预检', () => {
  it('缺 script 位 → submit 直接拒（不建卡）', async () => {
    const { state, gate } = makeDeps({ permissionsOf: async () => ['query'] });
    await expect(state.submit({ connection: 'c', script: 'SELECT 1', sessionId: 's' }))
      .rejects.toThrow(/script/);
    expect(gate.created).toHaveLength(0);
  });
  it('逐条分类缺位 → 报语句序号与缺失位', async () => {
    const { state } = makeDeps({ permissionsOf: async () => ['query', 'script'], analyze: realAnalyze });
    await expect(state.submit({ connection: 'c', script: 'SELECT 1;\nDROP TABLE t;', sessionId: 's' }))
      .rejects.toThrow(/第 2 条.*ddl_table/);
  });
  it('dryrun 同样受检', async () => {
    const { state } = makeDeps({ permissionsOf: async () => ['query', 'script'], analyze: realAnalyze });
    await expect(state.submit({ connection: 'c', script: 'DROP TABLE t;', sessionId: 's', dryrun: true }))
      .rejects.toThrow(/ddl_table/);
  });
  it('权限齐 → 正常建卡', async () => {
    const { state, gate } = makeDeps({ permissionsOf: async () => ['query', 'script', 'insert'] });
    const r = await state.submit({ connection: 'c', script: 'SELECT 1', sessionId: 's' });
    expect(r.status).toBe('pending');
    expect(gate.created).toHaveLength(1);
  });
});
