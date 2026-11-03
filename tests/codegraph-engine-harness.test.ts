// tests/codegraph-engine-harness.test.ts（momo-plugin）
//
// 自 momo-studio electron/tests/plugin/codegraph-engine-harness.test.ts 随迁
// （spec 2026-11-03 §3.2）。原语义保留：真引擎双 ws 双语言（TS/Java）各自经
// getOrStartMcp 拉起 codegraph 实例，断言各自命中各自语言的符号——Java 命中是
// dap-e_server 惨案的回归锁。
//
// 跨仓改造（本文件与原版的全部差异）：
//  1. 宿主模块一律 beforeAll 内动态 import（静态 import 会在 skipIf 判定前做
//     模块解析——宿主缺失时整文件红而非 skip，spec §3.2 硬性要求）
//  2. skipIf 条件扩为：宿主可达（package.json + node_modules 在位）且引擎在位
//  3. 宿主类型改为内联最小形状（零 TS 耦合——宿主 refactor 只需同步本文件的
//     内联 interface，README 耦合警告即指此处）
//  4. tmpRoot 惰性创建（skip 时不留孤儿临时目录）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';

// ── 可达性判定（先于任何宿主 import）──────────────────────────────────────
// 宿主根解析：env 显式设置即独占（设错 → 不可达 → skip，可诊断不静默回退）；
// 未设置才探测候选 sibling 目录——宿主 checkout 目录名不固定（本机为
// moo-studio，官方名 momo-studio），按 electron/package.json 存在性探测而非
// 硬编码目录名（Task 2 Ruling，ledger 有案）。
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
const ENGINE_BIN = path.join(PLUGIN_ROOT, 'engine', 'bin', 'codegraph');
const ENGINE_READY = fs.existsSync(ENGINE_BIN);

// ── 宿主模块内联最小形状（零 TS 耦合契约面）───────────────────────────────
interface McpClient {
  callTool(name: string, args: unknown): Promise<unknown>;
}
interface DbHandle {
  prepare(sql: string): { run(...args: unknown[]): unknown };
}
interface KeychainImpl {
  setSecret(key: string, value: string): Promise<void>;
  getSecret(key: string): Promise<string | null>;
  deleteSecret(key: string): Promise<void>;
}
interface HostModules {
  runMigrations(): void;
  getDb(): DbHandle;
  closeDb(): void;
  setKeychainImpl(impl: KeychainImpl): void;
  getOrStartMcp(wsId: string, cfg: unknown): Promise<McpClient>;
  stopAllMcpForWorkspace(wsId: string): void;
}
// beforeAll 内赋值；skipIf 守卫保证 hooks 只在 READY 时执行——hook 内非空断言安全
let host: HostModules | null = null;

let tmpRoot = '';
const vault = new Map<string, string>();

function wsDir(name: string): string {
  return path.join(tmpRoot, name);
}

function seedWs(name: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(wsDir(name), rel)), { recursive: true });
    fs.writeFileSync(path.join(wsDir(name), rel), content);
  }
}

// Java 样例：dap-e_server 同款形态（InitGuideApplicationServiceImpl + 调用方）
const JAVA_FILES = {
  'src/main/java/com/x/InitGuideApplicationServiceImpl.java': `package com.x;

public class InitGuideApplicationServiceImpl {
    public String getOverview(boolean refresh) {
        return "overview:" + refresh;
    }

    public String getStatus() {
        return getOverview(false);
    }
}
`,
  'src/main/java/com/x/InitGuideController.java': `package com.x;

public class InitGuideController {
    private final InitGuideApplicationServiceImpl initGuideApplicationService = new InitGuideApplicationServiceImpl();

    public String overview() {
        return initGuideApplicationService.getOverview(true);
    }
}
`,
};

const TS_FILES = {
  'src/tasks.ts': `export function transitionTaskStatus(id: string, next: string): string {
  return id + ':' + next;
}
`,
  'src/flow.ts': `import { transitionTaskStatus } from './tasks';

export function completeTask(id: string): string {
  return transitionTaskStatus(id, 'done');
}
`,
};

const MANIFEST = {
  id: 'cg',
  name: 'cg',
  version: '2.0.0',
  components: { mcp: './mcp/mcp.json' },
};

function mcpConfigFor(): {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  transport: string;
  source: string;
  pluginId: string;
} {
  return {
    id: 'plugin-cg-codegraph',
    name: 'codegraph',
    command: 'node',
    args: [
      '${pluginRoot}/bin/boot.js',
      '--engine', '${engineBin}',
      '--root', '${config.workspaceRoot}',
    ],
    env: { CODEGRAPH_NO_DOWNLOAD: '1', CODEGRAPH_DIR: '.momo-codegraph' },
    transport: 'stdio',
    source: 'plugin',
    pluginId: 'cg',
  };
}

function seedPlugin(): void {
  const rec = {
    id: 'cg',
    version: '2.0.0',
    manifestJson: JSON.stringify(MANIFEST),
    sourcePath: PLUGIN_ROOT,
  };
  host!
    .getDb()
    .prepare(
      `INSERT OR REPLACE INTO plugins (id, version, manifest_json, state, source, source_path, installed_at)
       VALUES (?, ?, ?, 'active', 'dev', ?, 'x')`,
    )
    .run(rec.id, rec.version, rec.manifestJson, rec.sourcePath);
}

describe.skipIf(!HOST_READY || !ENGINE_READY)('真引擎双 ws 双语言 harness（L2 锚点）', () => {
  beforeAll(async () => {
    const dbUrl = pathToFileURL(path.join(HOST_ROOT, 'electron', 'src', 'main', 'storage', 'db.ts')).href;
    const mcpUrl = pathToFileURL(path.join(HOST_ROOT, 'electron', 'src', 'main', 'mcp', 'host-manager.ts')).href;
    const keychainUrl = pathToFileURL(path.join(HOST_ROOT, 'electron', 'src', 'main', 'storage', 'keychain.ts')).href;
    const [db, mcp, keychain] = await Promise.all([
      import(dbUrl),
      import(mcpUrl),
      import(keychainUrl),
    ]) as [
      { runMigrations(): void; getDb(): DbHandle; closeDb(): void },
      {
        getOrStartMcp(wsId: string, cfg: unknown): Promise<McpClient>;
        stopAllMcpForWorkspace(wsId: string): void;
      },
      { setKeychainImpl(impl: KeychainImpl): void },
    ];
    host = {
      runMigrations: db.runMigrations,
      getDb: db.getDb,
      closeDb: db.closeDb,
      setKeychainImpl: keychain.setKeychainImpl,
      getOrStartMcp: mcp.getOrStartMcp,
      stopAllMcpForWorkspace: mcp.stopAllMcpForWorkspace,
    };
  });

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-cgharness-'));
    process.env.AP_USER_DATA_DIR = tmpRoot;
    host!.setKeychainImpl({
      setSecret: async (k, v) => void vault.set(k, v),
      getSecret: async (k) => vault.get(k) ?? null,
      deleteSecret: async (k) => void vault.delete(k),
    });
    host!.runMigrations();
  });

  afterEach(() => {
    host!.stopAllMcpForWorkspace('ws-a');
    host!.stopAllMcpForWorkspace('ws-b');
    host!.closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  afterAll(() => {
    vault.clear();
  });

  it('TS 工作空间命中 TS 符号；Java 工作空间命中 Java 符号（惨案回归锁）', async () => {
    seedWs('ws-a', TS_FILES);
    seedWs('ws-b', JAVA_FILES);
    seedPlugin();
    host!
      .getDb()
      .prepare(
        `INSERT OR REPLACE INTO workspaces (id, name, directory_path, owner_id)
         VALUES ('ws-a', 'A', ?, '@o'), ('ws-b', 'B', ?, '@o')`,
      )
      .run(wsDir('ws-a'), wsDir('ws-b'));
    // scoped activation：行缺失=停用——补两 ws 启用（ws 行须先建，FK 约束）
    host!
      .getDb()
      .prepare(
        `INSERT OR IGNORE INTO plugin_enablements (workspace_id, plugin_id, enabled)
         VALUES ('ws-a', 'cg', 1), ('ws-b', 'cg', 1)`,
      )
      .run();

    const a = await host!.getOrStartMcp('ws-a', mcpConfigFor());
    const b = await host!.getOrStartMcp('ws-b', mcpConfigFor());

    // 引擎首启建图需要时间——轮询 explore 直到命中或超时（大仓真实语义）
    const exploreUntil = async (client: McpClient, symbol: string, ms: number): Promise<string> => {
      const deadline = Date.now() + ms;
      let last = '';
      while (Date.now() < deadline) {
        try {
          const r = await client.callTool('codegraph_explore', { query: symbol });
          last = JSON.stringify(r);
          if (!/未收录|not found|no match/i.test(last)) return last;
        } catch (err) {
          last = String(err);
        }
        await new Promise((res) => setTimeout(res, 1500));
      }
      return last;
    };

    const tsHit = await exploreUntil(a, 'transitionTaskStatus', 90_000);
    expect(tsHit).toContain('tasks.ts');
    expect(tsHit).not.toContain('InitGuide');

    const javaHit = await exploreUntil(b, 'InitGuideApplicationServiceImpl', 90_000);
    expect(javaHit).toContain('InitGuideApplicationServiceImpl.java');
    expect(javaHit).not.toContain('tasks.ts');

    // 索引数据落点：各自项目根下 .momo-codegraph/（与 CODEGRAPH_DIR 一致）
    expect(fs.existsSync(path.join(wsDir('ws-a'), '.momo-codegraph'))).toBe(true);
    expect(fs.existsSync(path.join(wsDir('ws-b'), '.momo-codegraph'))).toBe(true);
  }, 240_000);
});
