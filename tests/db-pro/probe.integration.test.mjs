// tests/db-pro/probe.integration.test.mjs
// 测试连接探测（2026-11-19 用户实证 [20006] 池别名冲突回归锁）：
// dmdb 池别名 = 连接串——已建池时再探测同串不得报错。
import { describe, it, expect } from 'vitest';
import net from 'node:net';

const ON = process.env.DBPRO_INTEGRATION === '1';

function reachable(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ port, host, timeout: 1500 });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.once('timeout', () => { s.destroy(); resolve(false); });
  });
}

describe.skipIf(!ON)('probeUrl（DM 池别名冲突回归锁）', () => {
  it('已存在同连接串池时，probeUrl 直连探测成功', async () => {
    if (!(await reachable(15236))) return;
    const url = process.env.DBPRO_DM ?? 'dm://SYSDBA:SYSDBA001@127.0.0.1:15236';
    const dm = await import('../../plugins/db-pro/engine/drivers/dm.js');
    const pool = await dm.createPool(url, { queryTimeoutMs: 30_000 });
    try {
      await expect(dm.probeUrl(url)).resolves.toBe(true);
    } finally {
      await pool.close().catch(() => undefined);
    }
  }, 120_000);
});
