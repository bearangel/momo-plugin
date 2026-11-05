// tests/email/dev-install.test.ts（momo-plugin）
//
// dev 目录装载全链路冒烟（Task 14 / spec §12 测试策略）：
//   manifest+panel 校验 → 7 工具装配 → panel 可见（page 位）→ agent 落库
//   → service 起停。全部走宿主真链（installPluginDevDir / loadPluginToolModules /
//   listPluginPanels）+ 宿主 DB 真值断言——不是 mock 替身。
//
// 隔离范式抄自 tests/dev-install-probe.test.ts：AP_USER_DATA_DIR 注入宿主
// userData 隔离（宿主 storage/db.ts 读该 env）+ runMigrations 建库 +
// 手插 workspaces 行（installPluginDevDir 的 originWorkspaceId 守卫与 panel
// enablement 都要求 ws 在位）。宿主模块延迟动态 import + skipIf 守卫同款
//（tests/host.ts 的 HOST_READY：宿主 checkout 与 node_modules 均在位）。
//
// 跨仓可达性：宿主根由 env MOMO_STUDIO_ROOT 显式指定（设错 → 不可达 → skip）；
// 未设置才探测 sibling 候选目录（宿主 checkout 目录名不固定）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HOST_READY, hostImport } from '../host';
import { PLUGIN_ROOT, VENDOR_REAL } from './fixtures';

interface DbStatement {
  run(...args: unknown[]): unknown;
  get(...args: unknown[]): unknown;
}
interface DbHandle {
  prepare(sql: string): DbStatement;
}
interface PluginRecordLike {
  id: string;
  version: string;
  source: string;
  sourcePath: string;
}
interface PanelInfoLike {
  pluginId: string;
  panelId: string;
  title: string;
  placement: string;
  entryUrl: string;
}
interface ToolDefLike {
  name: string;
}
interface ToolModuleLike {
  getDefs(): ToolDefLike[];
}
interface EmailHost {
  runMigrations(): void;
  getDb(): DbHandle;
  closeDb(): void;
  installPluginDevDir(dir: string, currentAppVersion: string, originWorkspaceId: string): PluginRecordLike;
  stopPluginService(id: string): Promise<void>;
  listPluginPanels(workspaceId: string): PanelInfoLike[];
  loadPluginToolModules(
    refs: unknown[],
    log: (msg: string, meta?: unknown) => void,
  ): { modules: ToolModuleLike[]; failures: unknown[] };
}

const WS_ID = 'ws-email-smoke';
/** 插件 7 工具短名全集（宿主装配后强制加 plugin:email/ 前缀） */
const TOOL_SHORT_NAMES = [
  'draft_mail',
  'list_accounts',
  'list_folders',
  'list_mails',
  'read_mail',
  'save_attachment',
  'send_draft',
] as const;

let host: EmailHost | null = null;
let tmpRoot = '';

describe.skipIf(!HOST_READY)('email dev 装载全链路', () => {
  beforeAll(async () => {
    const [db, installer, service, panelSync, pluginTools] = (await Promise.all([
      hostImport('storage/db.ts'),
      hostImport('plugin/installer.ts'),
      hostImport('plugin/service-manager.ts'),
      hostImport('plugin/panel-sync.ts'),
      hostImport('agent/tools/plugin-tools.ts'),
    ])) as [
      { runMigrations(): void; getDb(): DbHandle; closeDb(): void },
      { installPluginDevDir(dir: string, currentAppVersion: string, ws: string): PluginRecordLike },
      { stopPluginService(id: string): Promise<void> },
      { listPluginPanels(workspaceId: string): PanelInfoLike[] },
      {
        loadPluginToolModules(
          refs: unknown[],
          log: (msg: string, meta?: unknown) => void,
        ): { modules: ToolModuleLike[]; failures: unknown[] };
      },
    ];
    host = {
      runMigrations: db.runMigrations,
      getDb: db.getDb,
      closeDb: db.closeDb,
      installPluginDevDir: installer.installPluginDevDir,
      stopPluginService: service.stopPluginService,
      listPluginPanels: panelSync.listPluginPanels,
      loadPluginToolModules: pluginTools.loadPluginToolModules,
    };
  });

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-email-dev-'));
    process.env.AP_USER_DATA_DIR = tmpRoot;
    host!.runMigrations();
    host!
      .getDb()
      .prepare(
        `INSERT OR IGNORE INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`,
      )
      .run(WS_ID, '邮件冒烟工作区', '/tmp/email-smoke-ws', '@o');
  });

  afterEach(async () => {
    // installPluginDevDir 会拉起插件 service（fire-and-forget）——先停再关库，
    // 防句柄/监听泄漏挂住 vitest 退出（同 dev-install-probe 范式）
    await host!.stopPluginService('email').catch(() => undefined);
    host!.closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  it('installPluginDevDir 注册成功：id=email + manifest/panel 双校验过（dev 源不拷贝）', () => {
    const rec = host!.installPluginDevDir(PLUGIN_ROOT, '9.9.9', WS_ID);
    expect(rec.id).toBe('email');
    expect(rec.version).toBe('0.1.0');
    // dev 源语义：记录直指源目录（不拷贝进 <userData>/plugins/installed）
    expect(rec.source).toBe('dev');
    expect(rec.sourcePath).toBe(PLUGIN_ROOT);
  });

  it('7 个工具模块全部装配：failures 零 + 工具名恰为 7 个 plugin:email/*', () => {
    const modulePaths = fs
      .readdirSync(path.join(PLUGIN_ROOT, 'tools'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => path.join(PLUGIN_ROOT, 'tools', f));
    expect(modulePaths).toHaveLength(7);
    const r = host!.loadPluginToolModules(
      [{ pluginId: 'email', modulePaths, config: {}, dataDir: tmpRoot }],
      () => {},
    );
    expect(r.failures).toEqual([]);
    const names = r.modules.flatMap((m) => m.getDefs().map((d) => d.name)).sort();
    expect(names).toEqual(TOOL_SHORT_NAMES.map((n) => `plugin:email/${n}`).sort());
  });

  it('panel 清单含 mail 面板（pluginId=email + placement=page）', () => {
    host!.installPluginDevDir(PLUGIN_ROOT, '9.9.9', WS_ID);
    const panels = host!.listPluginPanels(WS_ID);
    const mail = panels.find((p) => p.pluginId === 'email' && p.panelId === 'mail');
    expect(mail).toBeTruthy();
    expect(mail!.placement).toBe('page');
    expect(mail!.entryUrl).toContain('email');
  });

  it('agent 落库：plugin:email:email-assistant 在 agent_definitions，default_tools 解析后 8 条', () => {
    host!.installPluginDevDir(PLUGIN_ROOT, '9.9.9', WS_ID);
    const row = host!
      .getDb()
      .prepare(`SELECT id, source, default_tools FROM agent_definitions WHERE id = ?`)
      .get('plugin:email:email-assistant') as
      | { id: string; source: string; default_tools: string }
      | undefined;
    expect(row).toBeTruthy();
    expect(row!.source).toBe('plugin');
    const tools = JSON.parse(row!.default_tools) as Array<{ kind: string; ref: string }>;
    expect(tools).toHaveLength(8);
    // read_file（内置）+ 7 个 plugin:email/*（插件命名空间）
    expect(tools.map((t) => t.ref).sort()).toEqual(
      ['read_file', ...TOOL_SHORT_NAMES.map((n) => `plugin:email/${n}`)].sort(),
    );
  });

  it('createService 冒烟：start → 未知方法中文错误 → stop（真 vendor require 链）', async () => {
    if (!VENDOR_REAL) throw new Error('vendor 未安装：请在 plugins/email/vendor 执行 npm install');
    const requirePlugin = createRequire(path.join(PLUGIN_ROOT, 'service', 'index.js'));
    const mod = requirePlugin(path.join(PLUGIN_ROOT, 'service', 'index.js')) as {
      createService(ctx: {
        getDataDir(): string;
        secrets: {
          get(key: string): Promise<string | null>;
          set(key: string, value: string): Promise<void>;
          delete(key: string): Promise<void>;
        };
        logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
      }): {
        start(): Promise<void>;
        stop(): Promise<void>;
        handle(method: string, params: unknown): Promise<unknown>;
      };
    };
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-smoke-'));
    // 冒烟环境不落真实 HOME 下的默认归档目录（~/.momo-plugin/email）
    const prevKill = process.env.MOMO_EMAIL_ARCHIVE_DISABLE_DEFAULT;
    process.env.MOMO_EMAIL_ARCHIVE_DISABLE_DEFAULT = '1';
    const svc = mod.createService({
      getDataDir: () => dataDir,
      getConfig: () => ({}),
      secrets: { get: async () => null, set: async () => {}, delete: async () => {} },
      logger: { info() {}, warn() {}, error() {} },
    });
    try {
      await svc.start();
      await expect(svc.handle('nope', {})).rejects.toThrow('未知方法');
      const cfg = (await svc.handle('config.get', {})) as { showRemoteImages: boolean; archiveRoot: string };
      expect(cfg).toEqual({ showRemoteImages: false, archiveRoot: '' });
    } finally {
      if (prevKill === undefined) delete process.env.MOMO_EMAIL_ARCHIVE_DISABLE_DEFAULT;
      else process.env.MOMO_EMAIL_ARCHIVE_DISABLE_DEFAULT = prevKill;
      await svc.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
