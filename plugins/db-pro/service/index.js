'use strict';
// db-pro service（主进程常驻，spec §4.2）：引擎子进程生命周期 / 配置解析与
// 每次 diff / 读代理 / 写两段式（write-state.js）。
// Runtime 阶梯按 spike/RESULT.md 定论 L2：系统 node + --openssl-legacy-provider
//（Electron 内嵌 Node 无该开关——L1 实测 bad option）；分发兜底 L3 见 RESULT.md。
const { spawn } = require('node:child_process');
const path = require('node:path');
const { diffConnections, sanitizeTimeoutMs, sanitizeScriptTimeoutMs, validateWriteConnection } = require('./config-connections');
const { createConnectionsStore } = require('./connections-store');
const { createWriteState } = require('./write-state');
const { createScriptState } = require('./script-state');
const { isFatalSpawnError } = require('./spawn-diag');

const ENGINE_BOOT_TIMEOUT_MS = 8_000;
/** 退避序列（spec §8：1s / 5s / 30s 封顶；成功后归零） */
const BACKOFF_STEPS_MS = [1_000, 5_000, 30_000];

const READ_METHODS = new Set([
  'query', 'meta.listSchemas', 'meta.listTables', 'meta.listViews',
  'meta.describe', 'meta.columns', 'meta.ddl', 'explain',
]);

function createService(ctx) {
  const engineEntry = path.join(__dirname, '..', 'engine', 'engine.js');
  let child = null;
  let nextId = 1;
  let stopping = false;
  let backoffIdx = -1; // -1 = 未在退避
  let restartTimer = null;
  let lastConnections = [];
  let lastUnavailable = new Map(); // I-6：坏槽名 → 引擎侧失败原因（listConnections 回吐）
  const pending = new Map(); // rpc id → {resolve, reject, timer}

  const writeState = createWriteState({
    humanGate: () => {
      if (!ctx.humanGate) throw new Error('宿主未注入 humanGate（需包含该扩展的 momo-studio 版本）');
      return ctx.humanGate;
    },
    execSql: (connection, sql) => rpc('exec', { connection, sql }),
    dataDir: ctx.getDataDir(),
    log: (msg, meta) => ctx.logger.warn(msg, meta),
    permissionsOf: async (name) => {
      const rows = await store.listForEngine().catch(() => []);
      const hit = rows.find((r) => r.name === name);
      return hit ? hit.permissions : [];
    },
  });

  const scriptState = createScriptState({
    humanGate: () => {
      if (!ctx.humanGate) throw new Error('宿主未注入 humanGate（需包含该扩展的 momo-studio 版本）');
      return ctx.humanGate;
    },
    analyze: async (connection, script) => {
      if (!child) throw new Error('db-pro 引擎未就绪（启动中/重启中，请稍后重试）');
      return await rpc('scriptAnalyze', { script, dialect: dialectOfUrl(connection) }, 30_000);
    },
    run: async (payload) => {
      if (!child) throw new Error('db-pro 引擎未就绪（脚本作业中止）');
      const timeoutMs = sanitizeScriptTimeoutMs(ctx.getConfig().script_timeout_ms);
      return await rpc('scriptRun', {
        connection: payload.connection,
        script: payload.script,
        onError: payload.onError,
        scriptTimeoutMs: timeoutMs,
      }, timeoutMs + 5_000);
    },
    dataDir: ctx.getDataDir(),
    log: (msg, meta) => ctx.logger.warn(msg, meta),
    permissionsOf: async (name) => {
      const rows = await store.listForEngine().catch(() => []);
      const hit = rows.find((r) => r.name === name);
      return hit ? hit.permissions : [];
    },
  });

  const store = createConnectionsStore({
    dataDir: ctx.getDataDir(),
    secrets: ctx.secrets,
    log: (msg, meta) => ctx.logger.warn(msg, meta),
  });

  // ── 引擎进程管理 ─────────────────────────────────────────────
  function spawnEngine() {
    // I-8（复审）：bootEngine ping 超时路径的旧「假死」引擎进程无人回收——
    // 重 spawn 前先终结仍存活的旧 child（stdio 管道随进程释放）
    if (child && !child.killed) {
      try { child.kill('SIGTERM'); } catch { /* 已死 */ }
    }
    const command = 'node'; // L2：PATH 系统 node（Spike #0 定论；dev 机 24 线）
    const args = ['--openssl-legacy-provider', engineEntry]; // dmdb 握手硬需求（spec §1.3）
    child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    // I-7（复审）：引擎 crash-exit 后 killed 仍为 false，'exit' 处理前的窗口内
    // rpc 写管道触发 EPIPE——stdin 无 error 监听会变主进程未捕获异常
    child.stdin.on('error', () => undefined);
    let buf = '';
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() === '') continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const p = pending.get(msg.id);
        if (!p) continue;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
        else p.resolve(msg.result);
      }
    });
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk) => ctx.logger.info(`db-pro 引擎 stderr: ${chunk.trim().slice(0, 400)}`));
    child.on('error', (err) => {
      // M3：node 缺失（ENOENT）一次性人话停机——环境缺陷重试不可治愈
      if (isFatalSpawnError(err)) {
        ctx.logger.error(
          'db-pro 引擎无法启动：未找到 node 可执行文件（PATH 无 node）。插件不可用——请安装 Node.js 后在插件页重载。',
        );
        stopping = true;
        child = null;
        for (const [, p] of pending) {
          clearTimeout(p.timer);
          p.reject(new Error('db-pro 引擎不可用：本机未安装 Node.js'));
        }
        pending.clear();
        return;
      }
      onEngineExit(`spawn 失败: ${err.message}`);
    });
    child.on('exit', (code) => onEngineExit(`退出 code=${code}`));
  }

  function onEngineExit(reason) {
    if (stopping || !child) return;
    child = null;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`db-pro 引擎进程已退出（${reason}）——自动重启中，请稍后重试`));
    }
    pending.clear();
    scheduleRestart();
  }

  function scheduleRestart() {
    backoffIdx = Math.min(backoffIdx + 1, BACKOFF_STEPS_MS.length - 1);
    const delay = BACKOFF_STEPS_MS[Math.max(backoffIdx, 0)];
    ctx.logger.warn(`db-pro 引擎异常退出，${delay}ms 后重启（第 ${backoffIdx + 1} 次）`);
    restartTimer = setTimeout(() => void bootEngine().catch(scheduleRestart), delay);
  }

  async function bootEngine() {
    clearTimeout(restartTimer);
    spawnEngine();
    await rpc('ping', {}, ENGINE_BOOT_TIMEOUT_MS);
    if (lastConnections.length > 0) {
      await rpc('configure', { connections: lastConnections }, ENGINE_BOOT_TIMEOUT_MS);
    }
    backoffIdx = -1; // 成功后退避归零
  }

  function rpc(method, params, timeoutMs = 30_000) {
    if (!child || child.killed) {
      return Promise.reject(new Error('db-pro 引擎未运行（重启中，请稍后重试）'));
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(
          new Error(`引擎请求超时: ${method} (${timeoutMs / 1000}s)——可用 WHERE/LIMIT 缩小查询`),
          { code: 'query_timeout' },
        ));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      } catch (err) {
        // I-7：进程刚死管道破裂的同步抛错面——转 reject 不上抛主进程
        pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`db-pro 引擎管道已断（${err.message}）——请重试`));
      }
    });
  }

  // ── 连接解析与配置 diff（spec 2026-11-19 §6.2）───────────────
  async function computeConns() {
    await store.warm();
    const queryTimeoutMs = sanitizeTimeoutMs(ctx.getConfig().query_timeout_ms);
    return (await store.listForEngine()).map((c) => ({ ...c, queryTimeoutMs }));
  }

  async function ensureConfig() {
    if (store.listProjection().length === 0) {
      try {
        const r = await store.migrateLegacy(ctx.getConfig());
        if (r.migrated > 0) ctx.logger.info(`已从旧版配置迁移 ${r.migrated} 个数据库连接`);
      } catch (err) {
        ctx.logger.warn('旧版连接配置迁移失败（不阻塞）', { error: err.message });
      }
    }
    const conns = await computeConns();
    if (!child) {
      // 引擎未就绪：先记真源，bootEngine 启动后按 lastConnections 下发
      lastConnections = conns;
      return;
    }
    if (diffConnections(lastConnections, conns)) {
      // 先 configure 成功再提交 lastConnections（终审 I1）：失败时 diff 仍判变，
      // 下次调用即重试——不会把失败配置楔死到重启
      const r = await rpc('configure', { connections: conns }, ENGINE_BOOT_TIMEOUT_MS);
      lastUnavailable = new Map((r.unavailable ?? []).map((u) => [u.name, u.reason]));
      lastConnections = conns;
    }
  }

  function defaultConnection() {
    const proj = store.listProjection();
    const def = proj.find((c) => c.isDefault);
    return (def ?? proj[0])?.name ?? '';
  }

  // I-6（复审）：URL 形态守卫——无 scheme 槽值（如裸 127.0.0.1）不炸整表
  function dialectOf(url) {
    try {
      return new URL(url).protocol.replace(':', '');
    } catch {
      return 'unknown';
    }
  }

  function dialectOfUrl(name) {
    const conn = lastConnections.find((c) => c.name === name);
    return conn ? dialectOf(conn.url) : 'mysql';
  }

  // 行数上限净化：负数 slice 会从尾部截（同类 -40 隐患）——非有限/<=0 归 200，封顶 10000
  function sanitizeMaxRows(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 200;
    return Math.min(Math.floor(n), 10_000);
  }

  async function handle(method, params) {
    if (method === 'write') {
      // 前置校验连接名（虚构名不建卡——批准流完整性，2026-11-18 stu 实证）
      if (child) await ensureConfig();
      validateWriteConnection(lastConnections, params.connection);
      return writeState.request(params);
    }
    if (method === 'writeStatus') return writeState.status(params);
    if (method === 'scriptExecute') {
      if (child) await ensureConfig();
      const withConn = params.connection ? params : { ...params, connection: defaultConnection() };
      validateWriteConnection(lastConnections, withConn.connection);
      return scriptState.submit(withConn);
    }
    if (method === 'scriptStatus') return scriptState.status(params);
    if (method === 'scriptHistory') return scriptState.history(params);
    if (method === 'connectionsList') {
      await store.warm();
      return { connections: store.listProjection() };
    }
    if (method === 'connectionsCreate') {
      await store.create(params);
      await ensureConfig();
      return { connections: store.listProjection() };
    }
    if (method === 'connectionsUpdate') {
      await store.update(String(params.id), params.patch ?? params);
      await ensureConfig();
      return { connections: store.listProjection() };
    }
    if (method === 'connectionsRemove') {
      await store.remove(String(params.id));
      await ensureConfig();
      return { connections: store.listProjection() };
    }
    if (method === 'connectionsSetDefault') {
      await store.setDefault(String(params.id));
      return { connections: store.listProjection() };
    }
    if (method === 'connectionsTest') {
      let url = typeof params.url === 'string' && params.url.trim() !== '' ? params.url.trim() : '';
      if (url === '') {
        const rows = await store.listForEngine();
        const hit = rows.find((r) => r.name === String(params.name));
        if (!hit) throw new Error('连接不存在或缺少密钥');
        url = hit.url;
      }
      const timeoutMs = sanitizeTimeoutMs(ctx.getConfig().query_timeout_ms);
      return await rpc('probe', { url, queryTimeoutMs: timeoutMs }, 20_000);
    }
    if (method === 'listConnections') {
      if (child) await ensureConfig();
      await store.warm();
      return {
        connections: store.listProjection().map((c) => {
          const reason = lastUnavailable.get(c.name);
          return {
            name: c.name, dialect: c.dialect, permissions: c.permissions,
            ok: reason === undefined, ...(reason !== undefined ? { reason } : {}),
          };
        }),
      };
    }
    if (READ_METHODS.has(method)) {
      if (!child) throw new Error('db-pro 引擎未就绪（启动中/重启中，请稍后重试）');
      await ensureConfig();
      const p = { ...params };
      if (!p.connection) p.connection = defaultConnection();
      if (method === 'query') {
        // M-A（复审）：rpc 超时随配置走（引擎侧超时 + 5s 余量，桥上限 60s 内）；
        // 超时/行数均过净化（负值归缺省——-40 实证：负超时直传致全量瞬时超时）
        p.maxRows = p.maxRows ?? sanitizeMaxRows(ctx.getConfig().readonly_max_rows);
        const cfgTimeout = sanitizeTimeoutMs(ctx.getConfig().query_timeout_ms);
        return await rpc(method, p, Math.min(cfgTimeout + 5_000, 55_000));
      }
      return await rpc(method, p);
    }
    throw new Error(`未知 service 方法: ${method}`);
  }

  return {
    async start() {
      try {
        await ensureConfig();
      } catch (err) {
        ctx.logger.warn('db-pro 连接初始化失败（修配置后自动生效）', { error: err.message });
      }
      try {
        await bootEngine();
      } catch (err) {
        ctx.logger.warn('db-pro 引擎首启失败（退避重试中）', { error: err.message });
        scheduleRestart();
      }
    },
    async stop() {
      stopping = true;
      clearTimeout(restartTimer);
      if (child) { child.kill('SIGTERM'); child = null; }
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error('插件已停止'));
      }
      pending.clear();
    },
    handle,
  };
}

module.exports = { createService };
