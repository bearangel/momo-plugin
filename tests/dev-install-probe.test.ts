// tests/dev-install-probe.test.ts（momo-plugin）
//
// dev 目录安装探针（spec §6-3）：宿主 installPluginDevDir 真链注册本仓真实
// codegraph 目录——断言 dev 记录落库（不拷贝）、manifest 校验通过、vendor
// probe（engine/bin/codegraph）可执行。这是「拆仓后 dev 工作流仍通」的最小
// 确定性验证（UI 插件卡由同一数据面渲染，不在本探针范围）。
//
// 宿主模块延迟动态 import + skipIf 语义与 codegraph-engine-harness.test.ts
// 同款（spec §3.2）；DB 隔离范式抄自宿主 tests/plugin/install-dev-dir.test.ts
// （AP_USER_DATA_DIR 注入 + runMigrations + 手插 ws 行）。
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
const ENGINE_BIN = path.join(PLUGIN_ROOT, 'engine', 'bin', 'codegraph');
const ENGINE_READY = fs.existsSync(ENGINE_BIN);

interface DbHandle {
  prepare(sql: string): { run(...args: unknown[]): unknown };
}
interface PluginRecordLike {
  id: string;
  version: string;
  source: string;
  sourcePath: string;
}
interface ProbeHost {
  runMigrations(): void;
  getDb(): DbHandle;
  closeDb(): void;
  installPluginDevDir(dir: string, currentAppVersion: string, originWorkspaceId: string): PluginRecordLike;
  stopPluginService(id: string): Promise<void>;
  getPlugin(id: string): { version: string } | null;
}
// beforeAll 内赋值；skipIf 守卫保证 hooks 只在 READY 时执行——hook 内非空断言安全
let host: ProbeHost | null = null;

let tmpRoot = '';

describe.skipIf(!HOST_READY || !ENGINE_READY)('dev 目录安装探针（真实插件目录）', () => {
  beforeAll(async () => {
    const dbUrl = pathToFileURL(path.join(HOST_ROOT, 'electron', 'src', 'main', 'storage', 'db.ts')).href;
    const installerUrl = pathToFileURL(
      path.join(HOST_ROOT, 'electron', 'src', 'main', 'plugin', 'installer.ts'),
    ).href;
    const serviceUrl = pathToFileURL(
      path.join(HOST_ROOT, 'electron', 'src', 'main', 'plugin', 'service-manager.ts'),
    ).href;
    const registryUrl = pathToFileURL(
      path.join(HOST_ROOT, 'electron', 'src', 'main', 'plugin', 'registry.ts'),
    ).href;
    const [db, installer, service, registry] = await Promise.all([
      import(dbUrl),
      import(installerUrl),
      import(serviceUrl),
      import(registryUrl),
    ]) as [
      { runMigrations(): void; getDb(): DbHandle; closeDb(): void },
      { installPluginDevDir(dir: string, v: string, ws: string): PluginRecordLike },
      { stopPluginService(id: string): Promise<void> },
      { getPlugin(id: string): { version: string } | null },
    ];
    host = {
      runMigrations: db.runMigrations,
      getDb: db.getDb,
      closeDb: db.closeDb,
      installPluginDevDir: installer.installPluginDevDir,
      stopPluginService: service.stopPluginService,
      getPlugin: registry.getPlugin,
    };
  });

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-probe-'));
    process.env.AP_USER_DATA_DIR = tmpRoot;
    host!.runMigrations();
    host!
      .getDb()
      .prepare(
        `INSERT OR IGNORE INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws-t', 'T', '/tmp/x', '@o')`,
      )
      .run();
  });

  afterEach(async () => {
    // installPluginDevDir 会拉起插件 service（fire-and-forget）——先停再关库，
    // 防 watcher 线程/句柄泄漏挂住 vitest 退出
    await host!.stopPluginService('codegraph').catch(() => undefined);
    host!.closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  it('installPluginDevDir 注册真实 codegraph：dev 源不拷贝 + manifest 过校验 + probe 可执行', () => {
    const rec = host!.installPluginDevDir(PLUGIN_ROOT, '2.1.0', 'ws-t');
    // dev 源语义：记录直指源目录（spec 2026-10-15 §7.2）
    expect(rec.source).toBe('dev');
    expect(rec.sourcePath).toBe(PLUGIN_ROOT);
    expect(rec.id).toBe('codegraph');
    // manifest 版本透传（真实 manifest v2.0.1——manifest 校验已在安装链内完成，
    // 走到这里即「校验过」）
    expect(rec.version).toBe('2.0.1');
    expect(host!.getPlugin('codegraph')?.version).toBe('2.0.1');
    // vendor probe 通过的确定性形态：引擎二进制在位且可执行（Review Focus 4）
    fs.accessSync(ENGINE_BIN, fs.constants.X_OK);
  });
});
