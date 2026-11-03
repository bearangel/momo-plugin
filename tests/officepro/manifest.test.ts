// tests/officepro/manifest.test.ts（momo-plugin）
//
// 插件 manifest 与预置 agent 校验锁（spec 2026-11-03 §5.1/§5.4）。自 momo-studio
// officepro 随迁：宿主校验器（plugin/manifest）经动态 import（skipIf 容忍宿主
// 缺失）；js-yaml 经 hostRequire 随宿主解析（本仓不装）。
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { HOST_READY, hostImport, hostRequire } from '../host';
import { PLUGIN_ROOT } from './fixtures';

interface HostManifest {
  parseManifest(text: string): unknown;
  validateManifest(manifest: unknown, root: string): void;
}
let manifestMod: HostManifest | null = null;
let yamlLoad: (text: string) => Record<string, unknown> = () => ({});

describe.skipIf(!HOST_READY)('office-pro 插件 manifest 与预置 agent', () => {
  beforeAll(async () => {
    manifestMod = (await hostImport('plugin/manifest.ts')) as unknown as HostManifest;
    yamlLoad = hostRequire<{ load: (t: string) => Record<string, unknown> }>('js-yaml').load;
  });

  it('manifest 通过 validateManifest（含交叉引用：run_js ↔ tools/run_js.js、office-authoring ↔ skills 子目录）', () => {
    const manifest = manifestMod!.parseManifest(fs.readFileSync(path.join(PLUGIN_ROOT, 'momo-plugin.json'), 'utf-8'));
    expect(() => manifestMod!.validateManifest(manifest, PLUGIN_ROOT)).not.toThrow();
  });

  it('agent YAML：defaultTools 含 plugin:office-pro/run_js 与 office 读取三件；不含 bash', () => {
    const raw = yamlLoad(fs.readFileSync(path.join(PLUGIN_ROOT, 'agents/office-pro.yaml'), 'utf-8')) as {
      spec?: { defaultTools?: Array<{ ref?: string }>; defaultSkills?: Array<{ ref?: string }> };
    };
    const refs = (raw.spec?.defaultTools ?? []).map((t) => t.ref ?? '');
    expect(refs).toContain('plugin:office-pro/run_js');
    expect(refs).toContain('office_read');
    expect(refs).toContain('office_read_cells');
    expect(refs).toContain('office_copy');
    expect(refs).not.toContain('bash');
    expect(raw.spec?.defaultSkills?.map((s) => s.ref)).toEqual(['office-authoring']);
  });
});
