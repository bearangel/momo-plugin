// 引擎主体单测：fake 驱动注入——configure diff / 只读校验接线 / 未配置连接错误 / 未知方法
import { describe, it, expect, vi } from 'vitest';
import engineMod from '../../plugins/db-pro/engine/engine.js';
const { createDispatcher } = engineMod;

function fakeDriver() {
  const closed = [];
  const pool = {
    dialect: 'mysql',
    ping: async () => undefined,
    query: async () => ({ columns: ['a'], rows: [[1]], total: 1, truncated: false }),
    listSchemas: async () => ['s1'],
    listTables: async () => [{ schema: 's1', name: 't1', type: 'table' }],
    listViews: async () => [],
    describe: async () => ({ columns: [], indexes: [], rowEstimate: 1 }),
    columns: async () => [],
    ddl: async () => 'CREATE TABLE t1 (a int)',
    explain: async () => ({ text: 'plan', operators: [], summary: '' }),
    exec: async () => ({ affectedRows: 1 }),
    close: async () => { closed.push(true); },
  };
  return { pool, closed };
}

const CFG = (url = 'mysql://u:p@h:3306/db') => [{ name: 'c1', url, queryTimeoutMs: 30000 }];

describe('createDispatcher', () => {
  it('configure 建池 + query 全链（只读校验通过）', async () => {
    const f = fakeDriver();
    const d = createDispatcher(() => ({ createPool: async () => f.pool }));
    const r = await d.dispatch('configure', { connections: CFG() });
    expect(r.configured).toBe(1);
    const q = await d.dispatch('query', { connection: 'c1', sql: 'SELECT 1', maxRows: 10 });
    expect(q.rows).toEqual([[1]]);
  });

  it('query 写语句被只读校验拒绝（readonly_rejected），不到驱动', async () => {
    const f = fakeDriver();
    const d = createDispatcher(() => ({ createPool: async () => f.pool }));
    await d.dispatch('configure', { connections: CFG() });
    await expect(d.dispatch('query', { connection: 'c1', sql: 'DELETE FROM t' }))
      .rejects.toMatchObject({ code: 'readonly_rejected' });
  });

  it('configure diff：URL 变更 → 旧池 close、新池建立', async () => {
    const f1 = fakeDriver();
    const f2 = fakeDriver();
    let which = 0;
    const d = createDispatcher(() => ({ createPool: async () => (which === 0 ? f1.pool : f2.pool) }));
    await d.dispatch('configure', { connections: CFG() });
    which = 1;
    await d.dispatch('configure', { connections: CFG('mysql://u:p@h:3306/db2') });
    expect(f1.closed).toHaveLength(1);
    const q = await d.dispatch('query', { connection: 'c1', sql: 'SELECT 1' });
    expect(q.rows).toEqual([[1]]);
  });

  it('未配置连接 → connection_failed；未知方法 → unknown_method', async () => {
    const d = createDispatcher(() => ({ createPool: async () => fakeDriver().pool }));
    await expect(d.dispatch('connTest', { name: 'nope' })).rejects.toMatchObject({ code: 'connection_failed' });
    await expect(d.dispatch('bogus', {})).rejects.toMatchObject({ code: 'unknown_method' });
  });

  it('exec 直通驱动（service 批准后路径，引擎不校验——信任边界在 service）', async () => {
    const f = fakeDriver();
    const d = createDispatcher(() => ({ createPool: async () => f.pool }));
    await d.dispatch('configure', { connections: CFG() });
    const r = await d.dispatch('exec', { connection: 'c1', sql: 'UPDATE t SET a=1' });
    expect(r.affectedRows).toBe(1);
  });
});

// 终审 C2：explain 路径前置只读校验（EXPLAIN ANALYZE 在 PG 会真实执行写语句）
describe('explain 前置只读校验（终审 C2）', () => {
  it('explain_query 传 ANALYZE DELETE → readonly_rejected', async () => {
    const f = fakeDriver();
    const d = createDispatcher(() => ({ createPool: async () => f.pool }));
    await d.dispatch('configure', { connections: CFG() });
    const explainSpy = vi.spyOn(f.pool, 'explain');
    await expect(d.dispatch('explain', { connection: 'c1', sql: 'ANALYZE DELETE FROM t' }))
      .rejects.toMatchObject({ code: 'readonly_rejected' });
    expect(explainSpy).not.toHaveBeenCalled();
  });
  it('合法 SELECT 的 explain 不受影响', async () => {
    const f = fakeDriver();
    const d = createDispatcher(() => ({ createPool: async () => f.pool }));
    await d.dispatch('configure', { connections: CFG() });
    const r = await d.dispatch('explain', { connection: 'c1', sql: 'SELECT * FROM t' });
    expect(r.text).toBe('plan');
  });
});

// 终审 I2：单连接失败不拖垮整批 configure（坏槽只记 unavailable，好连接可用）
describe('applyConfigure 逐连接隔离（终审 I2）', () => {
  it('坏 URL 槽位 → configure 成功 configured=1，坏名查询给人话错误', async () => {
    const f = fakeDriver();
    const d = createDispatcher(() => ({ createPool: async () => f.pool }));
    const r = await d.dispatch('configure', {
      connections: [
        { name: 'good', url: 'mysql://u:p@h/db', queryTimeoutMs: 30000 },
        { name: 'bad', url: 'not-a-url', queryTimeoutMs: 30000 },
      ],
    });
    expect(r.configured).toBe(1);
    expect(r.unavailable).toEqual([expect.objectContaining({ name: 'bad' })]);
    const q = await d.dispatch('query', { connection: 'good', sql: 'SELECT 1' });
    expect(q.rows).toEqual([[1]]);
    await expect(d.dispatch('query', { connection: 'bad', sql: 'SELECT 1' }))
      .rejects.toMatchObject({ code: 'connection_failed' });
  });
});

// 脚本执行 op（spec 2026-11-19 §5.3）：fake 驱动注入会话契约。
describe('scriptAnalyze / scriptRun（fake driver）', () => {
  function fakeSessionDriver() {
    const execLog = [];
    return {
      execLog,
      async createPool(url) {
        return {
          url,
          async ping() {},
          async close() {},
          async openSession() {
            return {
              async exec(sql) {
                execLog.push(sql);
                if (sql.includes('BOOM')) throw new Error('boom');
                return { affectedRows: 1 };
              },
              async finish(ok) { execLog.push(ok ? 'finish:ok' : 'finish:fail'); },
              async close() { execLog.push('close'); },
            };
          },
        };
      },
    };
  }

  async function setup() {
    const fake = fakeSessionDriver();
    const pools = new Map();
    const d = createDispatcher(() => fake, pools);
    await d.dispatch('configure', { connections: [{ name: 't', url: 'mysql://u:p@h/d', queryTimeoutMs: 1000 }] });
    return { d, fake };
  }

  it('scriptAnalyze 返回语句清单/摘要/脚本号，不触碰连接', async () => {
    const { d, fake } = await setup();
    const r = await d.dispatch('scriptAnalyze', { script: "SET @__script_no = 'X1';\nINSERT INTO a VALUES (1);", dialect: 'mysql' });
    expect(r.statements).toHaveLength(2);
    expect(r.scriptNo).toBe('X1');
    expect(r.summary.counts).toEqual({ session: 1, insert: 1 });
    expect(fake.execLog).toEqual([]);
  });

  it('scriptRun 顺序执行、收尾 ok、关闭会话', async () => {
    const { d, fake } = await setup();
    const r = await d.dispatch('scriptRun', { connection: 't', script: 'SELECT 1; SELECT 2;', onError: 'abort' });
    expect(r.ok).toBe(true);
    expect(r.executed).toBe(2);
    expect(fake.execLog).toEqual(['SELECT 1', 'SELECT 2', 'finish:ok', 'close']);
  });

  it('abort 失败即停并定位', async () => {
    const { d, fake } = await setup();
    const r = await d.dispatch('scriptRun', { connection: 't', script: 'SELECT 1; SELECT BOOM; SELECT 3;', onError: 'abort' });
    expect(r.ok).toBe(false);
    expect(r.failedAtIndex).toBe(2);
    expect(r.executed).toBe(2);
    expect(fake.execLog).toEqual(['SELECT 1', 'SELECT BOOM', 'finish:fail', 'close']);
  });

  it('continue 采集全部错误', async () => {
    const { d } = await setup();
    const r = await d.dispatch('scriptRun', { connection: 't', script: 'SELECT BOOM; SELECT 1;', onError: 'continue' });
    expect(r.ok).toBe(false);
    expect(r.results.filter((x) => x.status === 'failed')).toHaveLength(1);
    expect(r.executed).toBe(2);
  });

  it('GRANT 语句在预检即拒', async () => {
    const { d } = await setup();
    await expect(d.dispatch('scriptRun', { connection: 't', script: 'GRANT SELECT ON a TO b;', onError: 'abort' }))
      .rejects.toThrow(/GRANT|REVOKE/);
  });

  it('未配置连接 → 人话错误', async () => {
    const { d } = await setup();
    await expect(d.dispatch('scriptRun', { connection: 'nope', script: 'SELECT 1;' }))
      .rejects.toThrow(/未配置的连接/);
  });
});

// 逐连接权限 enforcement（spec 2026-11-19 §6.4）：配置态闸。
describe('权限 enforcement（配置态闸）', () => {
  async function setup(permissions) {
    const f = fakeDriver();
    const d = createDispatcher(() => ({ createPool: async () => f.pool }), new Map());
    await d.dispatch('configure', {
      connections: [{ name: 'ro', url: 'mysql://u:p@h/d', queryTimeoutMs: 1000, ...(permissions ? { permissions } : {}) }],
    });
    return d;
  }

  it('只读连接：query 放行、exec 拒（未授权 insert）', async () => {
    const d = await setup(['query']);
    const q = await d.dispatch('query', { connection: 'ro', sql: 'SELECT 1', maxRows: 5 });
    expect(q.rows).toEqual([[1]]);
    await expect(d.dispatch('exec', { connection: 'ro', sql: 'INSERT INTO t VALUES (1)' }))
      .rejects.toThrow(/insert/);
  });

  it('读写连接：insert 放行、DDL 拒（未授权 ddl_table）', async () => {
    const d = await setup(['query', 'insert', 'update', 'delete']);
    const r = await d.dispatch('exec', { connection: 'ro', sql: 'INSERT INTO t VALUES (1)' });
    expect(r.affectedRows).toBe(1);
    await expect(d.dispatch('exec', { connection: 'ro', sql: 'DROP TABLE t' })).rejects.toThrow(/ddl_table/);
  });

  it('缺省 permissions（A 期老配置）→ 全权放行（兼容）', async () => {
    const d = await setup(undefined);
    await expect(d.dispatch('exec', { connection: 'ro', sql: 'DROP TABLE t' })).resolves.toBeTruthy();
  });

  it('exec 对 GRANT 直接拒', async () => {
    const d = await setup(undefined);
    await expect(d.dispatch('exec', { connection: 'ro', sql: 'GRANT SELECT ON a TO b' })).rejects.toThrow(/GRANT|权限管理/);
  });

  it('scriptRun：无 script 位即拒；逐条分类缺位定位到语句', async () => {
    const ro = await setup(['query']);
    await expect(ro.dispatch('scriptRun', { connection: 'ro', script: 'SELECT 1;' })).rejects.toThrow(/script/);
    const rw = await setup(['query', 'script']);
    await expect(rw.dispatch('scriptRun', { connection: 'ro', script: 'SELECT 1;\nDROP TABLE t;' }))
      .rejects.toThrow(/第 2 条.*ddl_table/);
  });

  it('probe：临时建池 ping 后关闭（不污染池）', async () => {
    const closed = [];
    const pools = new Map();
    const d = createDispatcher(() => ({
      createPool: async () => ({ async ping() {}, async close() { closed.push(1); } }),
    }), pools);
    await expect(d.dispatch('probe', { url: 'mysql://u:p@h/d' })).resolves.toEqual({ ok: true });
    expect(closed).toHaveLength(1);
    expect(pools.size).toBe(0);
  });

  it('probe 不支持的协议 → 人话错误', async () => {
    const d = createDispatcher(() => ({ createPool: async () => ({ async ping() {}, async close() {} }) }), new Map());
    await expect(d.dispatch('probe', { url: 'sqlite://x' })).rejects.toThrow(/不支持的连接协议/);
  });
});

// 业务成功判定层 1（spec 2026-11-20 §4.1/§4.3）：CALL 输出 [FAIL] 标记 → 语句全 ok 也判业务失败
describe('scriptRun · 层1 业务判定与逐条明细（spec 2026-11-20）', () => {
  function cannedDriver(perStatement) {
    const execLog = [];
    return {
      execLog,
      pool: {
        async ping() {},
        async close() {},
        async openSession() {
          let i = 0;
          return {
            async exec(sql) {
              execLog.push(sql);
              const r = perStatement[i++];
              if (r === undefined) return { affectedRows: 0, outputs: null };
              if (r instanceof Error) throw r;
              return r;
            },
            async count() { return null; },
            async finish(ok) { execLog.push(ok ? 'finish:ok' : 'finish:fail'); },
            async close() { execLog.push('close'); },
          };
        },
      },
    };
  }
  async function setupCanned(perStatement) {
    const fake = cannedDriver(perStatement);
    const d = createDispatcher(() => ({ createPool: async () => fake.pool }));
    await d.dispatch('configure', { connections: [{ name: 't', url: 'mysql://u:p@h/d', queryTimeoutMs: 1000 }] });
    return { d, fake };
  }

  const FAIL_OUT = [{ columns: ['execution_status'], rows: [['[FAIL] S00971511 -- [23000] Duplicate entry']] }];

  it('语句全 ok + 层1 命中 → businessStatus failed、businessError 透传、逐条明细含 kind/outputs', async () => {
    const { d } = await setupCanned([
      { affectedRows: 0, outputs: null },
      { affectedRows: 0, outputs: null },
      { affectedRows: 0, outputs: FAIL_OUT },
      { affectedRows: 0, outputs: null },
    ]);
    const r = await d.dispatch('scriptRun', { connection: 't',
      script: 'SET @a = 1;\nDROP PROCEDURE IF EXISTS sp;\nCALL sp();\nDROP PROCEDURE IF EXISTS sp;' });
    expect(r.ok).toBe(true);
    expect(r.results.every((x) => x.status === 'ok')).toBe(true);
    expect(r.businessStatus).toBe('failed');
    expect(r.businessSource).toBe('layer1_marker');
    expect(r.businessError).toContain('[23000]');
    expect(r.results[2].kind).toBe('call');
    expect(r.results[2].outputs[0].rows[0][0]).toContain('[FAIL]');
    expect(typeof r.results[0].durationMs).toBe('number');
  });

  it('onError=continue 语句失败 + 层1 命中 → 语句失败优先（Review Focus 6）', async () => {
    const { d } = await setupCanned([
      { affectedRows: 0, outputs: null },
      new Error('boom'),
      { affectedRows: 0, outputs: FAIL_OUT },
    ]);
    const r = await d.dispatch('scriptRun', { connection: 't',
      script: 'SET @a=1;\nINSERT INTO t VALUES (1);\nCALL sp();', onError: 'continue' });
    expect(r.ok).toBe(false);
    expect(r.businessStatus).toBe('failed');
    expect(r.businessSource).toBe('statement');
    expect(r.businessError).toContain('boom');
  });

  it('无命中 → businessStatus ok', async () => {
    const { d } = await setupCanned([{ affectedRows: 2, outputs: null }]);
    const r = await d.dispatch('scriptRun', { connection: 't', script: 'INSERT INTO t VALUES (1);' });
    expect(r.businessStatus).toBe('ok');
    expect(r.businessError).toBeUndefined();
  });

  it('scriptAnalyze 并入 handler_order 警告', async () => {
    const d0 = createDispatcher(() => ({ createPool: async () => (await import('../../plugins/db-pro/engine/drivers/mysql.js')).createPool }));
    const r = await d0.dispatch('scriptAnalyze', { dialect: 'mysql', script:
      'DELIMITER //\nCREATE PROCEDURE sp_x()\nBEGIN\n DECLARE EXIT HANDLER FOR SQLEXCEPTION\n BEGIN\n  ROLLBACK;\n  GET DIAGNOSTICS CONDITION 1 @e = MESSAGE_TEXT;\n END;\nEND//\nDELIMITER ;' });
    expect(r.warnings.some((w) => w.type === 'handler_order')).toBe(true);
  });
});

// R6 核验快照（spec 2026-11-20 §7.2）：语句循环前后同会话 COUNT，delta=净增删
describe('scriptRun · verification 核验快照', () => {
  async function setupCounting(perTableCounts) {
    const callCount = new Map();
    const execLog = [];
    const pool = {
      async ping() {}, async close() {},
      async openSession() {
        return {
          async exec(sql) { execLog.push(sql); return { affectedRows: 0, outputs: null }; },
          async count(t) {
            const n = callCount.get(t) ?? 0;
            callCount.set(t, n + 1);
            return perTableCounts[t]?.[n] ?? null; // 第 1 次调用=before、第 2 次=after
          },
          async finish() {}, async close() {},
        };
      },
    };
    const d = createDispatcher(() => ({ createPool: async () => pool }));
    await d.dispatch('configure', { connections: [{ name: 't', url: 'mysql://u:p@h/d', queryTimeoutMs: 1000 }] });
    return { d, execLog };
  }

  it('before/after 两次 count + delta（含建表前 null / 删表后 null）', async () => {
    const { d } = await setupCounting({ t1: [5, 8], t2: [null, 3], t3: [2, null] });
    const r = await d.dispatch('scriptRun', { connection: 't',
      script: 'INSERT INTO t1 VALUES (1);\nINSERT INTO t2 VALUES (1);\nDROP TABLE t3;' });
    expect(r.verification).toEqual([
      { table: 't1', before: 5, after: 8, delta: 3 },
      { table: 't2', before: null, after: 3, delta: null },
      { table: 't3', before: 2, after: null, delta: null },
    ]);
  });

  it('表数超 20 只取前 20（去重后）', async () => {
    const counts = {};
    for (let i = 1; i <= 25; i += 1) counts[`t${i}`] = [1, 1];
    const { d } = await setupCounting(counts);
    const script = Array.from({ length: 25 }, (_, i) => `INSERT INTO t${i + 1} VALUES (1);`).join('\n');
    const r = await d.dispatch('scriptRun', { connection: 't', script });
    expect(r.verification.length).toBe(20);
    expect(r.verification[0].table).toBe('t1');
  });

  it('无目标表 → 不带 verification 字段', async () => {
    const { d } = await setupCounting({});
    const r = await d.dispatch('scriptRun', { connection: 't', script: 'SELECT 1;' });
    expect(r.verification).toBeUndefined();
  });

  it('同表多语句只计数一次表项（去重）', async () => {
    const { d } = await setupCounting({ t1: [1, 3] });
    const r = await d.dispatch('scriptRun', { connection: 't', script: 'INSERT INTO t1 VALUES (1);\nUPDATE t1 SET a = 1;' });
    expect(r.verification).toEqual([{ table: 't1', before: 1, after: 3, delta: 2 }]);
  });
});

// 层 2 权威判定（spec 2026-11-20 §4.2/§4.3）：scriptJudge 四项必齐 → 脚本尾查日志表，表内状态为权威
describe('scriptRun · 层2 scriptJudge 权威判定', () => {
  const JUDGE = { logTable: 'DAP_E_SCRIPT_EXECUTION_LOG', scriptNoColumn: 'SCRIPT_NO',
    statusColumn: 'EXECUTION_STATUS', errorColumn: 'ERROR_MESSAGE', okValue: 1, sortColumn: 'ID' };

  async function setupJudge(sessionImpl) {
    const pool = {
      async ping() {}, async close() {},
      async openSession() { return sessionImpl; },
    };
    const d = createDispatcher(() => ({ createPool: async () => pool }));
    await d.dispatch('configure', { connections: [{ name: 't', url: 'mysql://u:p@h/d', queryTimeoutMs: 1000, scriptJudge: JUDGE }] });
    return d;
  }
  function judgeSession(layer2Row) {
    const sqlLog = [];
    return {
      sqlLog,
      async exec(sql) {
        sqlLog.push(sql);
        if (/EXECUTION_STATUS/.test(sql)) return { affectedRows: 0,
          outputs: layer2Row === null ? null : [{ columns: ['s', 'e'], rows: [layer2Row] }] };
        return { affectedRows: 0, outputs: null };
      },
      async count() { return null; },
      async finish() {}, async close() {},
    };
  }

  it('日志表 STATUS=0 → businessStatus failed、ERROR_MESSAGE 透传、layer2 优先于层1', async () => {
    const s = judgeSession([0, '[HY000] Illegal mix of collations']);
    const d = await setupJudge(s);
    const r = await d.dispatch('scriptRun', { connection: 't',
      script: "SET @__script_no = 'S00971511';\nCALL sp();" });
    expect(r.businessStatus).toBe('failed');
    expect(r.businessSource).toBe('layer2_logtable');
    expect(r.businessError).toContain('[HY000]');
    expect(s.sqlLog.at(-1)).toContain('ORDER BY ID DESC');
    expect(s.sqlLog.at(-1)).toContain("'S00971511'");
  });

  it('日志表 STATUS=okValue → businessStatus ok（businessSource layer2）', async () => {
    const s = judgeSession([1, null]);
    const d = await setupJudge(s);
    const r = await d.dispatch('scriptRun', { connection: 't', script: "SET @__script_no = 'S1';\nCALL sp();" });
    expect(r.businessStatus).toBe('ok');
    expect(r.businessSource).toBe('layer2_logtable');
  });

  it('无 sortColumn 且探测不到自增主键 → 层2 降级告警、回落层1（Review Focus 3）', async () => {
    const probeSession = {
      sqlLog: [],
      async exec(sql) {
        this.sqlLog.push(sql);
        if (/information_schema\.COLUMNS/i.test(sql)) return { affectedRows: 0, outputs: null }; // 无自增列
        return { affectedRows: 0, outputs: null };
      },
      async count() { return null; },
      async finish() {}, async close() {},
    };
    const pool = { async ping() {}, async close() {}, async openSession() { return probeSession; } };
    const d = createDispatcher(() => ({ createPool: async () => pool }));
    await d.dispatch('configure', { connections: [{ name: 't', url: 'mysql://u:p@h/d', queryTimeoutMs: 1000,
      scriptJudge: { ...JUDGE, sortColumn: undefined } }] });
    const r = await d.dispatch('scriptRun', { connection: 't', script: "SET @__script_no = 'S1';\nCALL sp();" });
    expect(r.businessSource).not.toBe('layer2_logtable');
    expect(r.layer2Note).toContain('不可用');
  });

  it('脚本号未识别 → 跳过层2（不查日志表）', async () => {
    const s = judgeSession([1, null]);
    const d = await setupJudge(s);
    const r = await d.dispatch('scriptRun', { connection: 't', script: 'CALL sp();' });
    expect(r.businessSource).toBe(null === r.businessSource ? null : r.businessSource).toBeUndefined();
    expect(s.sqlLog.every((x) => !/EXECUTION_STATUS/.test(x))).toBe(true);
  });

  it('scriptJudge.failPattern 覆盖层1 默认正则；非法正则兜底默认（Review Focus 2）', async () => {
    const pool = { async ping() {}, async close() {}, async openSession() {
      return { async exec() { return { affectedRows: 0,
        outputs: [{ columns: ['s'], rows: [['[NOPE] not default marker']] }] }; },
        async count() { return null; }, async finish() {}, async close() {} };
    } };
    const d = createDispatcher(() => ({ createPool: async () => pool }));
    await d.dispatch('configure', { connections: [{ name: 't', url: 'mysql://u:p@h/d', queryTimeoutMs: 1000,
      scriptJudge: { failPattern: '^\\[NOPE\\]' } }] });
    const r = await d.dispatch('scriptRun', { connection: 't', script: 'CALL sp();' });
    expect(r.businessStatus).toBe('failed');
    expect(r.businessSource).toBe('layer1_marker');
  });
});

// R7（spec 2026-11-20 §8.1）：连接报错附可用列表，误用旧名可自我纠错
describe('connError · 报错附可用连接（R7）', () => {
  it('query 误用连接名 → 报错含当前可用列表', async () => {
    const f = fakeDriver();
    const d = createDispatcher(() => ({ createPool: async () => f.pool }));
    await d.dispatch('configure', { connections: CFG() });
    await expect(d.dispatch('query', { connection: 'nope', sql: 'SELECT 1' }))
      .rejects.toThrow(/未配置的连接 "nope"（当前可用：c1）/);
  });
  it('零连接 → 提示去面板添加', async () => {
    const d = createDispatcher(() => ({ createPool: async () => fakeDriver().pool }));
    await expect(d.dispatch('query', { connection: 'x', sql: 'SELECT 1' }))
      .rejects.toThrow(/当前无已配置连接——请到插件面板添加/);
  });
  it('scriptRun 同样受益（收敛重复手写报错）', async () => {
    const f = fakeDriver();
    const d = createDispatcher(() => ({ createPool: async () => f.pool }));
    await d.dispatch('configure', { connections: CFG() });
    await expect(d.dispatch('scriptRun', { connection: 'ghost', script: 'SELECT 1;' }))
      .rejects.toThrow(/当前可用：c1/);
  });
  it('坏连接（unavailable）→ 保留失败原因', async () => {
    const d = createDispatcher(() => ({ createPool: async () => { throw new Error('ETIMEDOUT x'); } }));
    await d.dispatch('configure', { connections: CFG() });
    await expect(d.dispatch('query', { connection: 'c1', sql: 'SELECT 1' }))
      .rejects.toThrow(/c1" 配置失败：ETIMEDOUT/);
  });
});

// scriptPrecheck 引擎方法（spec 2026-11-20 §6）：service dryrun 经 rpc 调用
describe('dispatch · scriptPrecheck', () => {
  it('切分脚本后调 runPrecheck，透传 items', async () => {
    const pool = {
      async ping() {}, async close() {},
      query: async (sql) => {
        if (/information_schema\.TABLES/i.test(sql)) return { columns: [], rows: [['t', 'utf8mb4_0900_ai_ci']] };
        if (/@@collation_database/i.test(sql)) return { columns: [], rows: [['utf8mb4_0900_ai_ci']] };
        if (/information_schema\.COLUMNS/i.test(sql)) return { columns: [], rows: [['t', 'a']] };
        if (/information_schema\.STATISTICS/i.test(sql)) return { columns: [], rows: [] };
        if (/COUNT/i.test(sql)) return { columns: [], rows: [[0]] };
        throw new Error('unexpected: ' + sql);
      },
    };
    const d = createDispatcher(() => ({ createPool: async () => pool }));
    await d.dispatch('configure', { connections: CFG() });
    const r = await d.dispatch('scriptPrecheck', { connection: 'c1', script: 'INSERT INTO t (a) VALUES (1);' });
    expect(r.supported).toBe(true);
    expect(Array.isArray(r.items)).toBe(true);
  });
  it('未配置连接 → connError；非 mysql → supported false', async () => {
    const d = createDispatcher(() => ({ createPool: async () => fakeDriver().pool }));
    await expect(d.dispatch('scriptPrecheck', { connection: 'x', script: 'SELECT 1;' })).rejects.toThrow(/当前可用|当前无已配置/);
    await d.dispatch('configure', { connections: [{ name: 'p', url: 'postgres://u:p@h/d', queryTimeoutMs: 1000 }] });
    const r = await d.dispatch('scriptPrecheck', { connection: 'p', script: 'SELECT 1;' });
    expect(r.supported).toBe(false);
  });
});
