// 引擎协议核心单测：帧解析 + runServer 分发（fake dispatcher 注入）
import { describe, it, expect, vi } from 'vitest';
import protoMod from '../../plugins/db-pro/engine/protocol.js';
const { CODES, EngineError, createLineFramer, runServer } = protoMod;

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('createLineFramer', () => {
  it('跨 chunk 半行拼接', () => {
    const f = createLineFramer();
    expect(f.feed('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(f.feed(':2}\n')).toEqual(['{"b":2}']);
  });
  it('空行跳过 + flush 冲刷尾部残留', () => {
    const f = createLineFramer();
    expect(f.feed('  \n{"x"')).toEqual([]);
    expect(f.flush()).toEqual(['{"x"}']);
  });
});

describe('runServer', () => {
  it('result 通道：dispatcher 返回值原样回带 id', async () => {
    const writes = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true; });
    const emit = (line) => process.stdin.emit('data', Buffer.from(line));
    try {
      runServer(async (method, params) => ({ echoed: method, params }));
      emit(JSON.stringify({ id: 7, method: 'ping', params: { a: 1 } }) + '\n');
      await settle();
      const resp = JSON.parse(writes.find((w) => w.includes('"id":7')));
      expect(resp.result).toEqual({ echoed: 'ping', params: { a: 1 } });
    } finally {
      spy.mockRestore();
      process.stdin.removeAllListeners('data');
    }
  });
  it('EngineError 带 code；普通错误落 INTERNAL；非法 JSON 回 BAD_REQUEST', async () => {
    const writes = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true; });
    const emit = (line) => process.stdin.emit('data', Buffer.from(line));
    try {
      runServer(async () => { throw new EngineError(CODES.VALIDATION, '只读拒绝'); });
      emit('{"id":1,"method":"x"}\n');
      await settle();
      runServer(async () => { throw new Error('boom'); });
      emit('{"id":2,"method":"x"}\n');
      emit('not-json\n');
      await settle();
      expect(JSON.parse(writes.find((w) => w.includes('"id":1'))).error).toEqual({ code: 'readonly_rejected', message: '只读拒绝' });
      expect(JSON.parse(writes.find((w) => w.includes('"id":2'))).error.code).toBe('internal');
      expect(JSON.parse(writes.find((w) => w.includes('"id":null'))).error.code).toBe('bad_request');
    } finally {
      spy.mockRestore();
      process.stdin.removeAllListeners('data');
    }
  });
});
