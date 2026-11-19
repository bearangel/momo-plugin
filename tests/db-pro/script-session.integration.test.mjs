// tests/db-pro/script-session.integration.test.mjs
// 脚本会话集成（spec 2026-11-19 §5.3）：四库专用连接 + 提交语义。
// 门控 DBPRO_INTEGRATION=1；容器未起的库 skip 不红。
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

const CASES = [
  { dialect: 'mysql', port: 13306, loader: () => import('../../plugins/db-pro/engine/drivers/mysql.js'),
    url: process.env.DBPRO_MYSQL ?? 'mysql://root:dbpro123@127.0.0.1:13306/dbpro', autoCommit: true },
  { dialect: 'postgres', port: 15432, loader: () => import('../../plugins/db-pro/engine/drivers/pg.js'),
    url: process.env.DBPRO_PG ?? 'postgres://postgres:dbpro123@127.0.0.1:15432/dbpro', autoCommit: true },
  { dialect: 'oracle', port: 11521, loader: () => import('../../plugins/db-pro/engine/drivers/oracle.js'),
    url: process.env.DBPRO_ORACLE ?? 'oracle://pdbadmin:dbpro123@127.0.0.1:11521/FREEPDB1', autoCommit: false },
  { dialect: 'dm', port: 15236, loader: () => import('../../plugins/db-pro/engine/drivers/dm.js'),
    url: process.env.DBPRO_DM ?? 'dm://SYSDBA:SYSDBA001@127.0.0.1:15236', autoCommit: false },
];

describe.skipIf(!ON)('脚本会话（四库）', () => {
  for (const c of CASES) {
    it(`${c.dialect}: 会话内提交成功 / abort 回滚（非自动提交方言）`, async () => {
      if (!(await reachable(c.port))) return;
      const mod = await c.loader();
      const pool = await mod.createPool(c.url, { queryTimeoutMs: 30_000 });
      const t = c.dialect === 'oracle' || c.dialect === 'dm' ? 'DBPRO_SESSION_T' : 'dbpro_session_t';
      try {
        const prep = await pool.openSession();
        await prep.exec(`DROP TABLE ${t}`).catch(() => undefined);
        await prep.exec(`CREATE TABLE ${t} (id INT)`);
        await prep.finish(true);
        await prep.close();

        const s1 = await pool.openSession();
        await s1.exec(`INSERT INTO ${t} VALUES (1)`);
        await s1.finish(true);
        await s1.close();

        const s2 = await pool.openSession();
        await s2.exec(`DELETE FROM ${t}`);
        await s2.finish(false);
        await s2.close();

        const check = await pool.query(`SELECT id FROM ${t}`, 10);
        if (c.autoCommit) {
          expect(check.rows.length).toBe(0);
        } else {
          expect(check.rows.length).toBe(1);
        }
      } finally {
        const cleanup = await pool.openSession();
        await cleanup.exec(`DROP TABLE ${t}`).catch(() => undefined);
        await cleanup.finish(true).catch(() => undefined);
        await cleanup.close().catch(() => undefined);
        await pool.close();
      }
    }, 120_000);
  }
});
