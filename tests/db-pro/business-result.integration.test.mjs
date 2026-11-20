// tests/db-pro/business-result.integration.test.mjs
// C 期集成回归（spec 2026-11-20 §9）：样本包 db-tool-sample 全场景——
// 基线 03 / P0 报成功实际失败 04 / 吞错（04 变体换 handler 顺序）/ R3 collation 对齐 05 /
// dryrun UK 预演 / 列匹配 / R7 报错。docker MySQL 8（表 collation=utf8mb4_0900_ai_ci）。
import { describe, it, expect, beforeAll } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures', 'db-tool-sample');
const readSql = (f) => fs.readFileSync(path.join(FIXTURES, f), 'utf-8');

const BASE_URL = process.env.DBPRO_MYSQL ?? 'mysql://root:dbpro123@127.0.0.1:13306/dbpro';
const DB_NAME = 'db_tool_sample';

function withDb(db) {
  const u = new URL(BASE_URL);
  u.pathname = `/${db}`;
  return u.toString();
}

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ port, host, timeout: 1500 });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.once('timeout', () => { s.destroy(); resolve(false); });
  });
}

const PERMS = ['query', 'insert', 'update', 'delete', 'ddl_table', 'ddl_other', 'procedure', 'script'];

async function makeEngine() {
  const engineMod = await import('../../plugins/db-pro/engine/engine.js');
  const { dispatch } = engineMod.createDispatcher();
  return dispatch;
}

/** 每场景全新现场：DROP/CREATE 库 → 01 建表 → 02 灌样例数据（引擎 scriptRun 走 DELIMITER 切分）。
 * mode='pre'：02 是「v4 成功后」导出（91021/23/24 等已注册 + 成功日志行）——删去这些
 * 产物与成功日志，还原「未注册、91115 冲突源在」的首登现场；mode='post' 原样保留。 */
async function freshScene(mode = 'pre') {
  const mysqlDriver = await import('../../plugins/db-pro/engine/drivers/mysql.js');
  const admin = await mysqlDriver.createPool(withDb('mysql'), { queryTimeoutMs: 20_000 });
  try {
    await admin.exec(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
    await admin.exec(`CREATE DATABASE \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  } finally {
    await admin.close();
  }
  const dispatch = await makeEngine();
  await dispatch('configure', { connections: [{ name: 'dape', url: withDb(DB_NAME), queryTimeoutMs: 20_000, permissions: PERMS }] });
  const r1 = await dispatch('scriptRun', { connection: 'dape', script: readSql('01_schema_ddl.sql') });
  expect(r1.ok).toBe(true);
  const r2 = await dispatch('scriptRun', { connection: 'dape', script: readSql('02_sample_data.sql') });
  expect(r2.ok).toBe(true);
  if (mode === 'pre') {
    const r3 = await dispatch('scriptRun', { connection: 'dape', script: [
      'DELETE FROM dap_e_mcp_endpoint WHERE ENDPOINT_ID IN (91021, 91023, 91024);',
      'DELETE FROM dap_e_mcp_tool WHERE TOOL_ID IN (90031, 90032, 90033, 90035, 90036);',
      'DELETE FROM dap_e_mcp_tool_binding WHERE BINDING_ID IN (92031, 92032, 92033, 92035, 92036);',
      "DELETE FROM dap_e_script_execution_log WHERE SCRIPT_NO = 'S00971511' AND EXECUTION_STATUS = 1;",
    ].join('\n') });
    expect(r3.ok).toBe(true);
  }
  return { dispatch };
}

const verifyOf = (r, table) => (r.verification ?? []).find((v) => v.table.toLowerCase() === table.toLowerCase());

const shouldRun = await portOpen(Number(new URL(BASE_URL).port || 3306));
const dIt = shouldRun ? it : it.skip;

describe('业务成功判定与预检 · 样本包全场景（docker MySQL 8）', () => {
  beforeAll(() => { if (!shouldRun) console.warn('跳过：127.0.0.1 MySQL docker 未启动'); });

  dIt('基线首登 03（pre 现场）：业务成功（无失败标记命中）+ 三表落库 3/5/5', async () => {
    const { dispatch } = await freshScene('pre');
    const r = await dispatch('scriptRun', { connection: 'dape', script: readSql('03_S00971511_v4_success.sql') });
    expect(r.ok).toBe(true);
    expect(r.businessStatus).toBe('ok');
    expect(verifyOf(r, 'dap_e_mcp_endpoint').delta).toBe(3);
    expect(verifyOf(r, 'dap_e_mcp_tool').delta).toBe(5);
    expect(verifyOf(r, 'dap_e_mcp_tool_binding').delta).toBe(5);
    const log = await dispatch('query', { connection: 'dape',
      sql: 'SELECT EXECUTION_STATUS FROM dap_e_script_execution_log WHERE SCRIPT_NO = \'S00971511\' ORDER BY LOG_ID DESC LIMIT 1' });
    expect(Number(log.rows[0][0])).toBe(1);
  }, 120_000);

  dIt('幂等跳过 03（post 现场，02 原样）：日志已有成功行 → SKIP 亦业务成功、零写入', async () => {
    const { dispatch } = await freshScene('post');
    const r = await dispatch('scriptRun', { connection: 'dape', script: readSql('03_S00971511_v4_success.sql') });
    expect(r.ok).toBe(true);
    expect(r.businessStatus).toBe('ok');
    expect(verifyOf(r, 'dap_e_mcp_endpoint').delta).toBe(0);
    const callOut = r.results.find((x) => x.kind === 'call')?.outputs?.[0]?.rows?.[0]?.[0] ?? '';
    expect(callOut).toContain('[SKIP]');
  }, 120_000);

  dIt('P0 复现 04（pre 现场）：语句全成功 + 业务失败（UK 冲突回滚），错误透传回执', async () => {
    const { dispatch } = await freshScene('pre');
    const r = await dispatch('scriptRun', { connection: 'dape', script: readSql('04_reproduce_uk_conflict.sql') });
    // P0 核心缺陷的修复证明：语句层 ok=true（CALL 正常返回），业务层 failed
    expect(r.ok).toBe(true);
    expect(r.results.every((x) => x.status === 'ok')).toBe(true);
    expect(r.businessStatus).toBe('failed');
    expect(r.businessSource).toBe('layer1_marker');
    expect(r.businessError).toContain('[FAIL]');
    expect(r.businessError).toContain('Duplicate');
    // 存储过程整体回滚：三表零落库；执行日志 +1（失败行）
    expect(verifyOf(r, 'dap_e_mcp_endpoint').delta).toBe(0);
    expect(verifyOf(r, 'dap_e_mcp_tool').delta).toBe(0);
    expect(verifyOf(r, 'dap_e_mcp_tool_binding').delta).toBe(0);
    expect(verifyOf(r, 'dap_e_script_execution_log').delta).toBe(1);
  }, 120_000);

  dIt('吞错复现（pre 现场，04 变体：handler 内 ROLLBACK 先于 GET DIAGNOSTICS）：[?] Unknown error 透传 + dryrun 警告', async () => {
    const { dispatch } = await freshScene('pre');
    const broken = readSql('04_reproduce_uk_conflict.sql').replace(
      /GET DIAGNOSTICS CONDITION 1\s*\n(\s*)(@\w+ = RETURNED_SQLSTATE,\s*\n\s*@__err_msg = MESSAGE_TEXT;)\s*\n(\s*)ROLLBACK;/,
      'ROLLBACK;\n$3GET DIAGNOSTICS CONDITION 1\n$1$2',
    );
    expect(broken).not.toEqual(readSql('04_reproduce_uk_conflict.sql')); // 确认变换生效
    const analysis = await dispatch('scriptAnalyze', { script: broken, dialect: 'mysql' });
    expect(analysis.warnings.some((w) => w.type === 'handler_order')).toBe(true);
    const r = await dispatch('scriptRun', { connection: 'dape', script: broken });
    expect(r.ok).toBe(true);
    expect(r.businessStatus).toBe('failed');
    expect(r.businessSource).toBe('layer1_marker');
    expect(r.businessError).toContain('[?] Unknown error');
    expect(verifyOf(r, 'dap_e_mcp_endpoint').delta).toBe(0);
  }, 120_000);

  dIt('R3 实证 05（pre 现场，无 SET NAMES、原版模板）：collation 自动对齐 → 业务成功', async () => {
    const { dispatch } = await freshScene('pre');
    const r = await dispatch('scriptRun', { connection: 'dape', script: readSql('05_reproduce_error_swallowed.sql') });
    // 修复前（驱动默认 utf8mb4_unicode_ci）：过程内 WHERE SCRIPT_NO = @var 必炸
    // Illegal mix of collations → 回滚；现在自动对齐 → 五能力注册成功
    expect(r.ok).toBe(true);
    expect(r.businessStatus).toBe('ok');
    expect(verifyOf(r, 'dap_e_mcp_endpoint').delta).toBe(3);
    const log = await dispatch('query', { connection: 'dape',
      sql: 'SELECT EXECUTION_STATUS FROM dap_e_script_execution_log WHERE SCRIPT_NO = \'S00971511\' ORDER BY LOG_ID DESC LIMIT 1' });
    expect(Number(log.rows[0][0])).toBe(1);
  }, 120_000);

  dIt('R4 预演：04 dryrun 报 UK 冲突 high（91022 与已存在记录冲突）', async () => {
    const { dispatch } = await freshScene('pre');
    const r = await dispatch('scriptPrecheck', { connection: 'dape', script: readSql('04_reproduce_uk_conflict.sql') });
    expect(r.supported).toBe(true);
    const hit = r.items.find((x) => x.code === 'uk_conflict');
    expect(hit).toBeDefined();
    expect(hit.level).toBe('high');
    expect(hit.message.toLowerCase()).toContain('dap_e_mcp_endpoint');
  }, 120_000);

  dIt('R4 列匹配：坏列名报 column_mismatch warn', async () => {
    const { dispatch } = await freshScene();
    const r = await dispatch('scriptPrecheck', { connection: 'dape',
      script: "INSERT INTO dap_e_mcp_endpoint (BAD_COL) VALUES (1);" });
    const hit = r.items.find((x) => x.code === 'column_mismatch');
    expect(hit.level).toBe('warn');
    expect(hit.message).toContain('BAD_COL');
  }, 120_000);

  dIt('R7：误用连接名报错附可用列表', async () => {
    const { dispatch } = await freshScene();
    await expect(dispatch('query', { connection: 'dev_db', sql: 'SELECT 1' }))
      .rejects.toThrow(/当前可用：dape/);
  }, 120_000);
});
