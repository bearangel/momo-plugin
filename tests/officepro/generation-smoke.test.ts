// tests/officepro/generation-smoke.test.ts（momo-plugin）
//
// 生成冒烟（spec 2026-11-03 §9.2 前置）：真 vendor + 真 run_js 链路。
// vendor 未构建时整体 skip（提示先跑 build.sh）——CI 无 vendor 不红，本地验收必跑。
// 自 momo-studio officepro 随迁：宿主模块动态 import；execSandboxed 为
// office-pro 分支设施（未合 main 前缺席 → skip，分支合并后自愈全绿）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_READY, hostFileExists, hostImport } from '../host';
import { PLUGIN_ROOT, VENDOR_REAL } from './fixtures';

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
interface HostFacilities {
  setSandboxState(state: unknown): void;
  setSandboxSettings(state: unknown): void;
  execSandboxed(req: unknown): Promise<ExecResult>;
  loadPluginToolModules(
    refs: Array<{ pluginId: string; rootDir: string; modulePaths: string[]; dataDir: string; config: Record<string, unknown> }>,
    log: (msg: string, meta?: unknown) => void,
  ): { modules: ToolModuleMin[]; failures: unknown[] };
  ReadTracker: new () => { add(roomId: string, abs: string, parent?: string): void };
  WorkspaceFS: new (root: string) => unknown;
}
let F: HostFacilities | null = null;

let tmp = '';
let wsDir = '';

function mkCtx(): Record<string, unknown> {
  const journal: Array<{ rel: string; op: string }> = [];
  return {
    wsFs: new F!.WorkspaceFS(wsDir),
    workspaceId: 'ws1',
    workspaceDir: wsDir,
    skillRegistry: {},
    streamSessionId: 's',
    roomId: 'r',
    sendStreamChunk: () => {},
    permissionConfig: { allowedTools: [], deniedTools: [] },
    creatorUserId: '',
    execSandboxed: (req: unknown) => F!.execSandboxed(req),
    recordFileChange: (_t: string, rel: string, op: string) => { journal.push({ rel, op }); },
    readTracker: new F!.ReadTracker(),
    __journal: journal,
  };
}

function loadTools(): ToolModuleMin {
  const ref = {
    pluginId: 'office-pro', rootDir: PLUGIN_ROOT,
    modulePaths: [path.join(PLUGIN_ROOT, 'tools/run_js.js')],
    dataDir: path.join(tmp, 'data'), config: {},
  };
  const { modules, failures } = F!.loadPluginToolModules([ref], vi.fn());
  expect(failures).toHaveLength(0);
  return modules[0]!;
}

describe.skipIf(!HOST_READY || !EXEC_READY || !VENDOR_REAL)('office-pro 生成冒烟（真 vendor 全链路；未构建请先跑 scripts/build.sh）', () => {
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
      { loadPluginToolModules: HostFacilities['loadPluginToolModules'] },
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

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-smoke-'));
    wsDir = path.join(tmp, 'ws');
    fs.mkdirSync(wsDir, { recursive: true });
  });

  beforeEach(() => {
    F!.setSandboxSettings({ mode: 'permissive', networkPolicy: 'deny' });
    F!.setSandboxState({ platform: process.platform, sandboxTool: null, toolVersion: null, available: false, unavailableReason: '单测钉 plain', windowsShell: null, executionPolicy: null, probedAt: 0 });
  });
  afterEach(() => {
    F!.setSandboxState(null);
    F!.setSandboxSettings(null);
  });

  it('pptxgenjs：run_js 产出 2 页 pptx → momo-validate ok + 记账 create', { timeout: 90000 }, async () => {
    const m = loadTools();
    const ctx = mkCtx();
    const r = await m.execute('plugin:office-pro/run_js', {
      script: `
        const PptxGenJS = require('pptxgenjs');
        const pptx = new PptxGenJS();
        pptx.defineLayout({ name: 'W', width: 10, height: 5.625 });
        pptx.layout = 'W';
        pptx.addSlide().addText('冒烟标题', { x: 0.6, y: 0.5, w: 8.8, h: 0.8, fontSize: 28, bold: true, color: '2D3436' });
        pptx.addSlide().addText('第二页', { x: 0.6, y: 0.5, w: 8.8, fontSize: 18 });
        await pptx.writeFile({ fileName: 'smoke.pptx' });
        const path = require('path');
        const { validateOfficeFile } = require('momo-validate');
        console.log('VALIDATE=' + JSON.stringify(validateOfficeFile(path.resolve('smoke.pptx'))));
      `,
      outputs: ['smoke.pptx'],
      timeout_ms: 60000,
    }, ctx);
    expect(r).toContain('退出码=0');
    expect(r).toContain('VALIDATE={"ok":true');
    expect(r).toContain('smoke.pptx: create 已记账');
    expect((ctx.__journal as Array<{ rel: string; op: string }>).length).toBe(1);
    expect(fs.existsSync(path.join(wsDir, 'smoke.pptx'))).toBe(true);
  });

  it('exceljs + momo-chart：xlsx + 原生图表注入 → validate ok + chart 部件存在', { timeout: 90000 }, async () => {
    const m = loadTools();
    const ctx = mkCtx();
    const r = await m.execute('plugin:office-pro/run_js', {
      script: `
        const ExcelJS = require('exceljs');
        const { injectXlsxChart } = require('momo-chart');
        const fs = require('fs');
        const path = require('path');
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('数据');
        ws.addRow(['季度', '销量']); ws.addRow(['Q1', 120]); ws.addRow(['Q2', 180]); ws.addRow(['Q3', 150]);
        await wb.xlsx.writeFile('smoke.xlsx');
        const buf = fs.readFileSync('smoke.xlsx');
        fs.writeFileSync('smoke.xlsx', injectXlsxChart(buf, {
          sheetName: '数据',
          anchor: { from: { col: 3, row: 1 }, to: { col: 9, row: 16 } },
          chart: { type: 'bar', title: '季度销量', series: [{ nameLiteral: '销量', catRef: '数据!$A$2:$A$4', catCache: ['Q1','Q2','Q3'], valRef: '数据!$B$2:$B$4', valCache: [120,180,150] }] },
        }));
        const AdmZip = require('adm-zip');
        const zip = new AdmZip('smoke.xlsx');
        console.log('CHART=' + zip.getEntries().some((e) => e.entryName.includes('charts/chart1.xml')));
        const { validateOfficeFile } = require('momo-validate');
        console.log('VALIDATE=' + JSON.stringify(validateOfficeFile(path.resolve('smoke.xlsx'))));
      `,
      outputs: ['smoke.xlsx'],
      timeout_ms: 60000,
    }, ctx);
    expect(r).toContain('退出码=0');
    expect(r).toContain('CHART=true');
    expect(r).toContain('VALIDATE={"ok":true');
    expect(fs.existsSync(path.join(wsDir, 'smoke.xlsx'))).toBe(true);
  });
});
