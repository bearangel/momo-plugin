import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import stateMod from '../../plugins/db-pro/service/write-state.js';
const { createWriteState } = stateMod;

function mkHarness() {
  const execSql = vi.fn(async () => ({ affectedRows: 3 }));
  const humanGate = {
    create: vi.fn(async () => 'req-1'),
    status: vi.fn(async () => null),
  };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbpro-ws-'));
  const state = createWriteState({
    humanGate: () => humanGate,
    execSql,
    dataDir,
    log: () => undefined,
  });
  return { state, execSql, humanGate, dataDir };
}

describe('write.request', () => {
  it('合法 DML → humanGate.create 收到完整载荷，返回 pending', async () => {
    const h = mkHarness();
    const r = await h.state.request({ connection: 'conn1', sql: 'UPDATE t SET a=1', sessionId: 's1', taskId: 't1' });
    expect(r).toEqual({ requestId: 'req-1', status: 'pending' });
    expect(h.humanGate.create).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      taskId: 't1',
      payloadJson: expect.stringContaining('"opClass":"DML"'),
    }));
  });
  it('缺 sessionId 拒绝（Review Focus #4）', async () => {
    const h = mkHarness();
    await expect(h.state.request({ connection: 'c', sql: 'DELETE FROM t', sessionId: '' }))
      .rejects.toThrow(/sessionId/);
  });
  it('只读语句 / 不支持首词 / 多语句拒绝', async () => {
    const h = mkHarness();
    await expect(h.state.request({ connection: 'c', sql: 'SELECT 1', sessionId: 's' })).rejects.toThrow(/拒绝/);
    await expect(h.state.request({ connection: 'c', sql: 'GRANT ALL', sessionId: 's' })).rejects.toThrow(/拒绝/);
    await expect(h.state.request({ connection: 'c', sql: 'DELETE FROM t; SELECT 1', sessionId: 's' })).rejects.toThrow(/拒绝/);
    expect(h.humanGate.create).not.toHaveBeenCalled();
  });
});

describe('write.status（两段式全转移）', () => {
  it('pending → 如实返回 pending（不执行）', async () => {
    const h = mkHarness();
    h.humanGate.status.mockResolvedValueOnce({
      id: 'r', status: 'pending', answerJson: null,
      payloadJson: '{"db":{"connection":"c","sql":"UPDATE t SET a=1","opClass":"DML"}}',
    });
    expect(await h.state.status({ requestId: 'r' })).toEqual({ status: 'pending' });
    expect(h.execSql).not.toHaveBeenCalled();
  });
  it('answered+deny → denied + 附言；不执行', async () => {
    const h = mkHarness();
    h.humanGate.status.mockResolvedValueOnce({
      id: 'r', status: 'answered',
      answerJson: JSON.stringify({ decision: 'deny', text: '危险操作' }),
      payloadJson: '{"db":{"connection":"c","sql":"UPDATE t SET a=1","opClass":"DML"}}',
    });
    expect(await h.state.status({ requestId: 'r' })).toEqual({ status: 'denied', note: '危险操作' });
    expect(h.execSql).not.toHaveBeenCalled();
  });
  it('answered+approve → 执行一次并返回 affectedRows；再次 status → replayed', async () => {
    const h = mkHarness();
    const row = {
      id: 'r', status: 'answered',
      answerJson: JSON.stringify({ decision: 'approve' }),
      payloadJson: '{"db":{"connection":"conn1","sql":"UPDATE t SET a=1","opClass":"DML"}}',
    };
    h.humanGate.status.mockResolvedValue(row);
    expect(await h.state.status({ requestId: 'r' })).toMatchObject({ status: 'executed', affectedRows: 3, opClass: 'DML' });
    expect(h.execSql).toHaveBeenCalledWith('conn1', 'UPDATE t SET a=1');
    expect(await h.state.status({ requestId: 'r' })).toMatchObject({ status: 'executed', affectedRows: 3, opClass: 'DML', replayed: true });
    expect(h.execSql).toHaveBeenCalledTimes(1);
  });
  it('执行中断窗口（终审 I3）：exec 失败后重查返回 exec_unknown，绝不重执行', async () => {
    const h = mkHarness();
    h.execSql.mockRejectedValueOnce(new Error('引擎请求超时'));
    const row = {
      id: 'r-3', status: 'answered',
      answerJson: JSON.stringify({ decision: 'approve' }),
      payloadJson: '{"db":{"connection":"c","sql":"UPDATE t SET a=1","opClass":"DML"}}',
    };
    h.humanGate.status.mockResolvedValue(row);
    // 首查：exec 超时——attempting 已落日志，错误向 agent 透出
    await expect(h.state.status({ requestId: 'r-3' })).rejects.toThrow(/超时/);
    // 重查：结果未知 → exec_unknown 人话，不再调用 execSql（宁可重查不可重执行，spec D7）
    expect(await h.state.status({ requestId: 'r-3' })).toMatchObject({ status: 'exec_unknown' });
    expect(h.execSql).toHaveBeenCalledTimes(1);
  });

  it('重启恢复：write-log.jsonl 已记录的 requestId 不再执行（Review Focus #3）', async () => {    const h = mkHarness();
    fs.appendFileSync(path.join(h.dataDir, 'write-log.jsonl'), JSON.stringify({ requestId: 'done-1', status: 'executed', affectedRows: 7, at: 1 }) + '\n');
    const state2 = stateMod.createWriteState({
      humanGate: () => h.humanGate, execSql: h.execSql, dataDir: h.dataDir, log: () => undefined,
    });
    h.humanGate.status.mockResolvedValue({
      id: 'done-1', status: 'answered',
      answerJson: JSON.stringify({ decision: 'approve' }),
      payloadJson: '{"db":{"connection":"c","sql":"UPDATE t SET a=1","opClass":"DML"}}',
    });
    expect(await state2.status({ requestId: 'done-1' })).toEqual({ status: 'executed', affectedRows: 7, replayed: true });
    expect(h.execSql).not.toHaveBeenCalled();
  });
  it('not_found / 载荷损坏 → 人话状态', async () => {
    const h = mkHarness();
    h.humanGate.status.mockResolvedValueOnce(null);
    expect(await h.state.status({ requestId: 'gone' })).toEqual({ status: 'not_found' });
    h.humanGate.status.mockResolvedValueOnce({
      id: 'bad', status: 'answered',
      answerJson: JSON.stringify({ decision: 'approve' }),
      payloadJson: 'not-json',
    });
    expect(await h.state.status({ requestId: 'bad' })).toEqual({ status: 'invalid_payload' });
  });
});
