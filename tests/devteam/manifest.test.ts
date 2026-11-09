// tests/devteam/manifest.test.ts
// dev-team 插件 manifest 校验锁（spec 2026-11-09 §3/§9）：基础字段 + 宿主 validateManifest
// （Task 3 落 agent YAML 后，第二个用例自动升级为 cross-ref 锁：defaultSkills ↔ skills 子目录）
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { HOST_READY, hostImport } from '../host';
import { PLUGIN_ROOT } from './fixtures';

let validateManifest: ((m: unknown, root: string) => void) | null = null;

describe.skipIf(!HOST_READY)('dev-team manifest', () => {
  beforeAll(async () => {
    validateManifest = ((await hostImport('plugin/manifest.ts')) as unknown as {
      validateManifest: (m: unknown, root: string) => void;
    }).validateManifest;
  });

  it('基础字段：id/name/version + components 仅 agents 与 skills 两入口', () => {
    const m = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'momo-plugin.json'), 'utf-8'));
    expect(m.id).toBe('dev-team');
    expect(m.version).toBe('0.1.0');
    expect(m.components).toEqual({ agents: './agents', skills: './skills' });
  });

  it('通过宿主 validateManifest（组件路径存在 + cross-ref）', () => {
    const m = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'momo-plugin.json'), 'utf-8'));
    expect(() => validateManifest!(m, PLUGIN_ROOT)).not.toThrow();
  });
});
