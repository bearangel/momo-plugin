'use strict';
// 引擎协议（spec §4.4）：NDJSON JSON-RPC——stdin 每行一个请求、stdout 每行一个响应。

/** 协议错误码（只读拒绝 = readonly_rejected，上层据此给人话提示） */
const CODES = {
  BAD_REQUEST: 'bad_request',
  UNKNOWN_METHOD: 'unknown_method',
  VALIDATION: 'readonly_rejected',
  CONN: 'connection_failed',
  TIMEOUT: 'query_timeout',
  DRIVER: 'driver_error',
  INTERNAL: 'internal',
};

class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

/** 行分帧器：喂入 chunk，产出完整行；半行缓冲跨 chunk 拼接 */
function createLineFramer() {
  let buf = '';
  return {
    feed(chunk) {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      return lines.filter((l) => l.trim() !== '');
    },
    flush() {
      const rest = buf.trim();
      buf = '';
      return rest === '' ? [] : [rest];
    },
  };
}

/**
 * 服务主循环：stdin 帧解析 → dispatcher → stdout 写响应。
 * dispatcher 抛 EngineError 走 error.code，其他错误落 internal。
 */
function runServer(dispatcher) {
  const framer = createLineFramer();
  const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  process.stdin.on('data', (chunk) => {
    for (const line of framer.feed(String(chunk))) {
      let req = null;
      try {
        req = JSON.parse(line);
      } catch {
        write({ id: null, error: { code: CODES.BAD_REQUEST, message: '非法 JSON 行' } });
        continue;
      }
      if (req === null || typeof req !== 'object' || typeof req.method !== 'string') {
        write({ id: typeof req?.id === 'number' ? req.id : null, error: { code: CODES.BAD_REQUEST, message: '请求须为 {id, method, params}' } });
        continue;
      }
      void Promise.resolve()
        .then(() => dispatcher(req.method, req.params ?? {}))
        .then((result) => write({ id: req.id, result }))
        .catch((err) => {
          const code = err instanceof EngineError ? err.code : CODES.INTERNAL;
          write({ id: req.id, error: { code, message: err instanceof Error ? err.message : String(err) } });
        });
    }
  });
}

module.exports = { CODES, EngineError, createLineFramer, runServer };
