// tests/db-pro/script-e2e.integration.test.mjs
// 真实模板 E2E（spec 2026-11-19 §5.3）：DAP-E 种子脚本形状——DELIMITER +
// 存储过程 + 会话变量 + 事务 + 幂等跳过。首次执行落库、二次执行整体 SKIP。
import { describe, it, expect } from 'vitest';
import { createDispatcher } from '../../plugins/db-pro/engine/engine.js';

const ON = process.env.DBPRO_INTEGRATION === '1';
const MYSQL_URL = process.env.DBPRO_MYSQL ?? 'mysql://root:dbpro123@127.0.0.1:13306/dbpro';

const SCRIPT = `
SET @__script_no = 'S_TEST_0001';
DROP PROCEDURE IF EXISTS p_demo_seed;
DELIMITER //
CREATE PROCEDURE p_demo_seed()
BEGIN
  DECLARE v_done INT DEFAULT 0;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    INSERT INTO script_log (script_no, ok) VALUES (@__script_no, 0);
    RESIGNAL;
  END;
  SELECT COUNT(*) INTO v_done FROM script_log WHERE script_no = @__script_no AND ok = 1;
  IF v_done > 0 THEN
    SELECT 'SKIP' AS result;
  ELSE
    START TRANSACTION;
    INSERT INTO seed_t (name) VALUES ('a');
    INSERT INTO seed_t (name) VALUES ('b');
    INSERT INTO script_log (script_no, ok) VALUES (@__script_no, 1);
    COMMIT;
    SELECT 'DONE' AS result;
  END IF;
END //
DELIMITER ;
CALL p_demo_seed();
`;

describe.skipIf(!ON)('MySQL 脚本 E2E · 通用模板形状', () => {
  it('首次执行落库、二次执行整体 SKIP', async () => {
    const pools = new Map();
    const d = createDispatcher(undefined, pools);
    await d.dispatch('configure', { connections: [{ name: 'e2e', url: MYSQL_URL, queryTimeoutMs: 30_000 }] });
    await d.dispatch('exec', { connection: 'e2e', sql: 'DROP TABLE IF EXISTS script_log' });
    await d.dispatch('exec', { connection: 'e2e', sql: 'DROP TABLE IF EXISTS seed_t' });
    await d.dispatch('exec', { connection: 'e2e', sql: 'DROP PROCEDURE IF EXISTS p_demo_seed' });
    await d.dispatch('exec', { connection: 'e2e', sql: 'CREATE TABLE seed_t (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(20))' });
    await d.dispatch('exec', { connection: 'e2e', sql: 'CREATE TABLE script_log (script_no VARCHAR(40) COLLATE utf8mb4_unicode_ci, ok TINYINT)' });

    const first = await d.dispatch('scriptRun', { connection: 'e2e', script: SCRIPT, onError: 'abort' });
    expect(first.ok).toBe(true);
    expect(first.executed).toBe(4);

    const rows1 = await d.dispatch('query', { connection: 'e2e', sql: 'SELECT COUNT(*) AS n FROM seed_t', maxRows: 10 });
    expect(Number(rows1.rows[0][0])).toBe(2);

    const second = await d.dispatch('scriptRun', { connection: 'e2e', script: SCRIPT, onError: 'abort' });
    expect(second.ok).toBe(true);

    const rows2 = await d.dispatch('query', { connection: 'e2e', sql: 'SELECT COUNT(*) AS n FROM seed_t', maxRows: 10 });
    expect(Number(rows2.rows[0][0])).toBe(2);

    await d.dispatch('exec', { connection: 'e2e', sql: 'DROP PROCEDURE IF EXISTS p_demo_seed' });
    await d.dispatch('exec', { connection: 'e2e', sql: 'DROP TABLE IF EXISTS script_log' });
    await d.dispatch('exec', { connection: 'e2e', sql: 'DROP TABLE IF EXISTS seed_t' });
    for (const h of pools.values()) await h.pool.close().catch(() => undefined);
  }, 120_000);
});
