// tests/officepro/run-js.test.ts（momo-plugin）
//
// run_js 工具全链路锁（spec 2026-11-03 §5.2）：真 loadPluginToolModules 装配 +
// 真 execSandboxed + 真 bootstrap + 假 vendor（不依赖 npm install）。
// readTracker 用真实 ReadTracker 实例（无 DB 时 add 降级内存语义——与宿主
// read-tracker.test.ts / office-tools.test.ts 同范式，保真度优先）。
//
// 自 momo-studio officepro 随迁：宿主模块全部 beforeAll 动态 import；execSandboxed
// 为 office-pro 分支设施（未合 main 前缺席 → skip，分支合并后自愈全绿）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_READY, hostFileExists, hostImport } from '../host';
import { PLUGIN_ROOT, makeFakeVendor } from './fixtures';

const EXEC_READY = hostFileExists('agent/tools/shared/sandboxed-exec.ts');

interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  spawnTag: string;
}
interface ToolModuleMin {
  getDefs(): Array<{ name: string }>;
  handles(name: string): boolean;
  execute(name: string, args: unknown, ctx: unknown): Promise<string>;
}
interface PluginToolRefMin {
  pluginId: string;
  rootDir: string;
  modulePaths: string[];
  dataDir: string;
  config: Record<string, unknown>;
}
interface HostFacilities {
  setSandboxState(state: unknown): void;
  setSandboxSettings(state: unknown): void;
  execSandboxed(req: unknown): Promise<ExecResult>;
  loadPluginToolModules(refs: PluginToolRefMin[], log: (msg: string, meta?: unknown) => void): { modules: ToolModuleMin[]; failures: unknown[] };
  ReadTracker: new () => { add(roomId: string, abs: string, parent?: string): void };
  WorkspaceFS: new (root: string) => unknown;
}
let F: HostFacilities | null = null;

interface JournalEntry { toolName: string; rel: string; op: string; before: Buffer | null }

/** 测试上下文：宿主 ToolContext 形状的最小内联（免跨仓类型耦合） */
interface TestCtx {
  wsFs: unknown;
  workspaceId: string;
  workspaceDir: string;
  skillRegistry: unknown;
  streamSessionId: string;
  roomId: string;
  sendStreamChunk: (chunk: unknown) => void;
  permissionConfig: { allowedTools: string[]; deniedTools: string[] };
  creatorUserId: string;
  execSandboxed?: (req: unknown) => Promise<ExecResult>;
  recordFileChange?: (toolName: string, rel: string, op: string, before: Buffer | null, after: Buffer | null) => unknown;
  readTracker?: { add(roomId: string, abs: string, parent?: string): void };
  abortSignal?: AbortSignal;
  __journal: JournalEntry[];
}

let tmp = '';
let wsDir = '';
// 真 vendor 目录不依赖 → 用假 vendor 顶替：把假 vendor 造在插件 vendor/ 下会被
// .gitignore 排除且污染插件目录，故测试用「临时插件根」——复制 bootstrap/tools 到
// tmp，vendor 用假件（结构等价，协议不变）。
let testPluginRoot = '';

function mkCtx(over: Partial<TestCtx> = {}): TestCtx {
  const journal: JournalEntry[] = [];
  const ctx: TestCtx = {
    wsFs: new F!.WorkspaceFS(wsDir),
    workspaceId: 'ws1',
    workspaceDir: wsDir,
    skillRegistry: {},
    streamSessionId: 'test-stream',
    roomId: 'test-room',
    sendStreamChunk: () => {},
    permissionConfig: { allowedTools: [], deniedTools: [] },
    creatorUserId: '',
    execSandboxed: (req) => F!.execSandboxed(req),
    recordFileChange: (toolName, rel, op, before) => { journal.push({ toolName, rel, op, before }); },
    readTracker: new F!.ReadTracker(),
    __journal: journal,
    ...over,
  };
  return ctx;
}

function loadTools(): ToolModuleMin {
  const ref: PluginToolRefMin = {
    pluginId: 'office-pro',
    rootDir: testPluginRoot,
    modulePaths: [path.join(testPluginRoot, 'tools/run_js.js')],
    dataDir: path.join(tmp, 'data'),
    config: {},
  };
  const { modules, failures } = F!.loadPluginToolModules([ref], vi.fn());
  expect(failures).toHaveLength(0);
  return modules[0]!;
}

describe.skipIf(!HOST_READY || !EXEC_READY)('run_js 工具模块', () => {
  beforeAll(async () => {
    const [probe, settings, sandboxedExec, pluginTools, readTracker, workspaceFs] = await Promise.all([
      hostImport('sandbox/probe.ts'),
      hostImport('sandbox/settings.ts'),
      hostImport('agent/tools/shared/sandboxed-exec.ts'),
      hostImport('agent/tools/plugin-tools.ts'),
      hostImport('agent/tools/shared/read-tracker.ts'),
      hostImport('files/workspace-fs.ts'),
    ]) as [
      { __setSandboxStateForTest(s: unknown): void },
      { __setSandboxSettingsForTest(s: unknown): void },
      { execSandboxed(req: unknown): Promise<ExecResult> },
      { loadPluginToolModules(refs: PluginToolRefMin[], log: (msg: string, meta?: unknown) => void): { modules: ToolModuleMin[]; failures: unknown[] } },
      { ReadTracker: HostFacilities['ReadTracker'] },
      { WorkspaceFS: HostFacilities['WorkspaceFS'] },
    ];
    F = {
      setSandboxState: probe.__setSandboxStateForTest,
      setSandboxSettings: settings.__setSandboxSettingsForTest,
      execSandboxed: sandboxedExec.execSandboxed,
      loadPluginToolModules: pluginTools.loadPluginToolModules,
      ReadTracker: readTracker.ReadTracker,
      WorkspaceFS: workspaceFs.WorkspaceFS,
    };

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-runjs-'));
    wsDir = path.join(tmp, 'ws');
    fs.mkdirSync(wsDir, { recursive: true });
    testPluginRoot = path.join(tmp, 'office-pro');
    fs.mkdirSync(path.join(testPluginRoot, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(testPluginRoot, 'bootstrap'), { recursive: true });
    fs.copyFileSync(path.join(PLUGIN_ROOT, 'bootstrap/run.js'), path.join(testPluginRoot, 'bootstrap/run.js'));
    fs.copyFileSync(path.join(PLUGIN_ROOT, 'tools/run_js.js'), path.join(testPluginRoot, 'tools/run_js.js'));
    makeFakeVendor(path.join(testPluginRoot, 'vendor'));
  });

  beforeEach(() => {
    F!.setSandboxSettings({ mode: 'permissive', networkPolicy: 'deny' });
    F!.setSandboxState({ platform: process.platform, sandboxTool: null, toolVersion: null, available: false, unavailableReason: '单测钉 plain', windowsShell: null, executionPolicy: null, probedAt: 0 });
  });
  afterEach(() => {
    F!.setSandboxState(null);
    F!.setSandboxSettings(null);
  });

  it('装配：命名空间 plugin:office-pro/run_js + 前缀门禁', () => {
    const m = loadTools();
    expect(m.getDefs().map((d) => d.name)).toEqual(['plugin:office-pro/run_js']);
    expect(m.handles('plugin:office-pro/run_js')).toBe(true);
    expect(m.handles('run_js')).toBe(false);
  });

  it('成功路径：产物写入 + create 记账 + 返回文本含记账行', async () => {
    const m = loadTools();
    const readTracker = new F!.ReadTracker();
    const addSpy = vi.spyOn(readTracker, 'add');
    const ctx = mkCtx({ readTracker });
    const r = await m.execute('plugin:office-pro/run_js', {
      script: `require('fs').writeFileSync('ok.txt', 'hello'); console.log('done');`,
      outputs: ['ok.txt'],
      timeout_ms: 20000,
    }, ctx);
    expect(r).toContain('退出码=0');
    expect(r).toContain('done');
    expect(r).toContain('ok.txt: create 已记账');
    expect(ctx.__journal).toEqual([{ toolName: 'plugin:office-pro/run_js', rel: 'ok.txt', op: 'create', before: null }]);
    expect(fs.existsSync(path.join(wsDir, 'ok.txt'))).toBe(true);
    // add 三参契约（roomId, abs, parentStreamSessionId）——真实 ReadTracker 签名锁
    expect(addSpy).toHaveBeenCalledWith('test-room', path.join(wsDir, 'ok.txt'), undefined);
  });

  it('Review Focus：outputs 越界（../）→ 执行前抛错', async () => {
    const m = loadTools();
    await expect(m.execute('plugin:office-pro/run_js', {
      script: `console.log(1)`, outputs: ['../evil.txt'],
    }, mkCtx())).rejects.toThrow();
  });

  it('Review Focus：未声明产物不记账（只记 outputs 列表）', async () => {
    const m = loadTools();
    const ctx = mkCtx();
    await m.execute('plugin:office-pro/run_js', {
      script: `require('fs').writeFileSync('a.txt','1'); require('fs').writeFileSync('b.txt','2');`,
      outputs: ['a.txt'],
      timeout_ms: 20000,
    }, ctx);
    expect(ctx.__journal).toHaveLength(1);
    expect(ctx.__journal[0]!.rel).toBe('a.txt');
    expect(fs.existsSync(path.join(wsDir, 'b.txt'))).toBe(true); // 文件在，只是不入账
  });

  it('覆盖已存在文件且未读 → readTracker 门禁抛错（对齐 office 写工具）', async () => {
    const m = loadTools();
    fs.writeFileSync(path.join(wsDir, 'exist.txt'), 'old');
    const ctx = mkCtx();
    await expect(m.execute('plugin:office-pro/run_js', {
      script: `require('fs').writeFileSync('exist.txt','new');`,
      outputs: ['exist.txt'],
      timeout_ms: 20000,
    }, ctx)).rejects.toThrow(/未读取[\s\S]*office_read/);
  });

  it('Review Focus：execSandboxed 未注入 → 明确报错拒跑', async () => {
    const m = loadTools();
    const ctx = mkCtx();
    delete ctx.execSandboxed;
    await expect(m.execute('plugin:office-pro/run_js', { script: `console.log(1)` }, ctx)).rejects.toThrow('execSandboxed');
  });

  it('script 超 64KB → 抛错提示拆分', async () => {
    const m = loadTools();
    await expect(m.execute('plugin:office-pro/run_js', {
      script: '//' + 'x'.repeat(70 * 1024),
    }, mkCtx())).rejects.toThrow('64KB');
  });

  it('脚本失败 → 返回文本含退出码与 stderr', async () => {
    const m = loadTools();
    const r = await m.execute('plugin:office-pro/run_js', {
      script: `console.error('script-boom'); process.exit(1);`,
      timeout_ms: 20000,
    }, mkCtx());
    expect(r).toContain('退出码=1');
    expect(r).toContain('script-boom');
  });

  it('死循环 + timeout_ms=1000 → 超时强杀标注，Promise 必 resolve', async () => {
    const m = loadTools();
    const r = await m.execute('plugin:office-pro/run_js', {
      script: `while(true){}`, timeout_ms: 1000,
    }, mkCtx());
    expect(r).toContain('超时');
  });

  it('exec 前已中止（abortSignal.aborted）→ 直接返回「已中断」，不执行不记账', async () => {
    const m = loadTools();
    const ac = new AbortController();
    ac.abort();
    const ctx = mkCtx({ abortSignal: ac.signal });
    const r = await m.execute('plugin:office-pro/run_js', {
      script: `require('fs').writeFileSync('no-abort.txt','x');`,
      outputs: ['no-abort.txt'],
      timeout_ms: 20000,
    }, ctx);
    expect(r).toBe('已中断');
    expect(fs.existsSync(path.join(wsDir, 'no-abort.txt'))).toBe(false);
    expect(ctx.__journal).toHaveLength(0);
  });

  it('子进程启动失败（exitCode=null 且非超时/中止）→ 标注并跳过 outputs 记账', async () => {
    const m = loadTools();
    // 仿真 execSandboxed spawn error 事件的 resolve 形状（进程边界 mock）
    const ctx = mkCtx({
      execSandboxed: async () => ({
        exitCode: null, stdout: '', stderr: 'spawn ENOENT',
        timedOut: false, aborted: false, truncated: false, spawnTag: 'unsandboxed/net-off:单测',
      }),
    });
    const r = await m.execute('plugin:office-pro/run_js', {
      script: `console.log(1)`, outputs: ['ghost.txt'], timeout_ms: 20000,
    }, ctx);
    expect(r).toContain('子进程启动失败');
    expect(ctx.__journal).toHaveLength(0);
  });
});
