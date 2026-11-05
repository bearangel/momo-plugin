// manifest 校验锁：宿主 validateManifest + 组件五项路径形状
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { HOST_READY, hostImport } from '../host';
import { PLUGIN_ROOT } from './fixtures';

let validateManifest: ((m: unknown, root: string) => void) | null = null;

describe.skipIf(!HOST_READY)('email 插件 manifest', () => {
  beforeAll(async () => {
    const mod = (await hostImport('plugin/manifest.ts')) as unknown as {
      validateManifest: (m: unknown, root: string) => void;
    };
    validateManifest = mod.validateManifest;
  });

  it('manifest 通过 validateManifest（组件目录全部在位）', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'momo-plugin.json'), 'utf-8'));
    expect(manifest.id).toBe('email');
    validateManifest!(manifest, PLUGIN_ROOT);
  });

  it('组件五项齐全且为 ./ 相对路径', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'momo-plugin.json'), 'utf-8'));
    for (const k of ['tools', 'service', 'skills', 'agents', 'panel'] as const) {
      expect(manifest.components[k]).toMatch(/^\.\//);
    }
  });
});
