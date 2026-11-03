// tests/codegraph-boot-chain.test.ts（momo-plugin）
//
// 自 momo-studio electron/tests/plugin/codegraph-e2e.test.ts 用例④随迁
// （Task 4 Ruling，ledger 有案）：boot.js 进程链 C1 回归锁——宿主断连后
// 孙进程（引擎）随之退出。锁的是 boot.js 的信号转发 + stdin-EOF 联动语义
// （插件本体行为），经宿主 getOrStartMcp/disconnect 驱动（宿主侧同受验）。
//
// 跨仓改造同 harness 范式：宿主模块 beforeAll 动态 import + skipIf 容忍缺失。
// 假引擎内联（不需要 283MB 真引擎）——boot.js 在位即可跑。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';

// env 显式设置即独占（设错 → 不可达 → skip）；未设置才探测候选 sibling 目录
// （宿主 checkout 目录名不固定——Task 2 Ruling 同款）。
function resolveHostRoot(): string {
  const fromEnv = process.env.MOMO_STUDIO_ROOT;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return path.resolve(fromEnv);
  const candidates = [
    path.join(__dirname, '..', '..', 'momo-studio'),
    path.join(__dirname, '..', '..', 'moo-studio'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'electron', 'package.json'))) return c;
  }
  return candidates[candidates.length - 1]!;
}
const HOST_ROOT = resolveHostRoot();
const HOST_READY =
  fs.existsSync(path.join(HOST_ROOT, 'electron', 'package.json')) &&
  fs.existsSync(path.join(HOST_ROOT, 'electron', 'node_modules'));
const PLUGIN_ROOT = path.resolve(__dirname, '..', 'plugins', 'codegraph');
const BOOT_JS = path.join(PLUGIN_ROOT, 'bin', 'boot.js');
const BOOT_READY = fs.existsSync(BOOT_JS);

const PID = 'cg';

/** 假引擎 bin：MCP stdio server，serve 前写 pid 文件（孙进程存活探针） */
const FAKE_ENGINE = `#!/usr/bin/env node
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  if (msg.method === 'initialize') {
    send({ protocolVersion: '2024-11-05', capabilities: { tools: {} } });
  } else if (msg.method === 'tools/list') {
    send({ tools: [{ name: 'codegraph_explore', description: 'x', inputSchema: { type: 'object' } }] });
  } else if (msg.method === 'tools/call') {
    send({ content: [{ type: 'text', text: 'argv=' + JSON.stringify(process.argv.slice(2)) }], isError: false });
  }
});
`;

interface DbHandle {
  prepare(sql: string): { run(...args: unknown[]): unknown };
}
interface KeychainImpl {
  setSecret(key: string, value: string): Promise<void>;
  getSecret(key: string): Promise<string | null>;
  deleteSecret(key: string): Promise<void>;
}
interface BootChainHost {
  runMigrations(): void;
  getDb(): DbHandle;
  closeDb(): void;
  setKeychainImpl(impl: KeychainImpl): void;
  normalizeConfigSchema(schema: unknown): unknown;
  writePluginConfig(id: string, schema: unknown, values: Record<string, unknown>, wsId: string): Promise<void>;
  getOrStartMcp(wsId: string, cfg: unknown): { callTool(name: string, args: unknown): Promise<unknown>; disconnect(): Promise<void> };
  stopAllMcpForWorkspace(wsId: string): void;
}
// beforeAll 内赋值；skipIf 守卫保证 hooks 只在 READY 时执行——hook 内非空断言安全
let host: BootChainHost | null = null;

let tmpRoot = '';
const vault = new Map<string, string>();

describe.skipIf(!HOST_READY || !BOOT_READY)('boot.js 进程链 C1 回归锁（宿主断连 → 孙进程消亡）', () => {
  beforeAll(async () => {
    const dbUrl = pathToFileURL(path.join(HOST_ROOT, 'electron', 'src', 'main', 'storage', 'db.ts')).href;
    const keychainUrl = pathToFileURL(path.join(HOST_ROOT, 'electron', 'src', 'main', 'storage', 'keychain.ts')).href;
    const configUrl = pathToFileURL(path.join(HOST_ROOT, 'electron', 'src', 'main', 'plugin', 'config-store.ts')).href;
    const mcpUrl = pathToFileURL(path.join(HOST_ROOT, 'electron', 'src', 'main', 'mcp', 'host-manager.ts')).href;
    const [db, keychain, config, mcp] = await Promise.all([
      import(dbUrl),
      import(keychainUrl),
      import(configUrl),
      import(mcpUrl),
    ]) as [
      { runMigrations(): void; getDb(): DbHandle; closeDb(): void },
      { setKeychainImpl(impl: KeychainImpl): void },
      { normalizeConfigSchema(schema: unknown): unknown; writePluginConfig(id: string, schema: unknown, values: Record<string, unknown>, wsId: string): Promise<void> },
      { getOrStartMcp(wsId: string, cfg: unknown): BootChainHost['getOrStartMcp']; stopAllMcpForWorkspace(wsId: string): void },
    ];
    host = {
      runMigrations: db.runMigrations,
      getDb: db.getDb,
      closeDb: db.closeDb,
      setKeychainImpl: keychain.setKeychainImpl,
      normalizeConfigSchema: config.normalizeConfigSchema,
      writePluginConfig: config.writePluginConfig,
      getOrStartMcp: mcp.getOrStartMcp,
      stopAllMcpForWorkspace: mcp.stopAllMcpForWorkspace,
    };
  });

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-bootchain-'));
    process.env.AP_USER_DATA_DIR = tmpRoot;
    host!.setKeychainImpl({
      setSecret: async (k, v) => void vault.set(k, v),
      getSecret: async (k) => vault.get(k) ?? null,
      deleteSecret: async (k) => void vault.delete(k),
    });
    host!.runMigrations();
    // ws 行（FK 约束前提）——本用例直注册 cfg，无需 plugins/enablements 行
    // （与原版 e2e ④ 同语义：锁进程链而非注册链）
    host!
      .getDb()
      .prepare(
        `INSERT OR REPLACE INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws-a', 'A', ?, '@o')`,
      )
      .run(path.join(tmpRoot, 'ws-a'));
  });

  afterEach(() => {
    host!.stopAllMcpForWorkspace('ws-a');
    host!.closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  it('宿主断连后孙进程（引擎）随之退出', async () => {
    // 假引擎 serve 前写 pid 文件——本用例的孙进程存活探针
    const pidFile = path.join(tmpRoot, 'grandchild.pid');
    const fakeBootEngine = FAKE_ENGINE.replace(
      "rl.on('line',",
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nrl.on('line',`,
    );
    const engineDir = path.join(tmpRoot, 'dev-plugin', 'engine', 'bin');
    fs.mkdirSync(engineDir, { recursive: true });
    fs.writeFileSync(path.join(engineDir, 'codegraph'), fakeBootEngine, {
      encoding: 'utf-8',
      mode: 0o755,
    });
    const schema = host!.normalizeConfigSchema({
      type: 'object',
      properties: { workspaceRoot: { type: 'string', title: '索引根目录', scope: 'workspace' } },
    });
    await host!.writePluginConfig(PID, schema, { workspaceRoot: path.join(tmpRoot, 'ws-a') }, 'ws-a');
    // boot 形态：command node + 真实 boot.js --engine <假引擎> --root <ws>
    // （直接注册定义，绕过 mcp.json——本用例锁进程链而非注册链）
    const cfg = {
      id: 'plugin-cg-codegraph',
      name: 'codegraph',
      version: '0.0.0',
      command: 'node',
      args: [
        BOOT_JS,
        '--engine', path.join(engineDir, 'codegraph'),
        '--root', path.join(tmpRoot, 'ws-a'),
      ],
      transport: 'stdio',
      source: 'plugin',
      pluginId: PID,
    };
    const client = await host!.getOrStartMcp('ws-a', cfg);
    await client.callTool('codegraph_explore', {});
    // 引擎孙进程已记录 pid
    await new Promise((r) => setTimeout(r, 300));
    const pid = Number(fs.readFileSync(pidFile, 'utf-8').trim());
    expect(pid).toBeGreaterThan(0);
    // 断连前存活态不设硬断言——宿主侧管道提前半关时 boot.js 的 stdin-EOF
    // 联动会先杀引擎（产品语义正确的路径）；核心不变量是 disconnect 后必死
    const aliveBefore = (() => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    })();
    void aliveBefore;
    // 宿主断连（kill 直接子进程 node boot.js）
    await client.disconnect();
    // 轮询孙进程消亡（信号转发 + stdin EOF 联动后应 ≤3s）
    const deadline = Date.now() + 8000;
    let gone = false;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 300)); }
      catch { gone = true; break; }
    }
    expect(gone).toBe(true); // 无论断连前死活，孙进程终态必须消亡
  }, 30000);
});
