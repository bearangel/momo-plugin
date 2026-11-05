// tests/email/panel-static.test.ts
// panel.json 形状 + 宿主 validatePanelsAtRoot + index.html 关键交互锚点
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { HOST_READY, hostImport } from '../host';
import { PLUGIN_ROOT } from './fixtures';

let validatePanelsAtRoot: ((root: string, manifest: unknown, pluginId: string) => unknown) | null = null;

describe.skipIf(!HOST_READY)('email panel', () => {
  beforeAll(async () => {
    validatePanelsAtRoot = ((await hostImport('plugin/panel-sync.ts')) as unknown as {
      validatePanelsAtRoot: (root: string, manifest: unknown, pluginId: string) => unknown;
    }).validatePanelsAtRoot;
  });

  it('panel.json 形状 + 宿主校验通过', () => {
    const decl = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'panel/panel.json'), 'utf-8'));
    expect(decl.panels).toHaveLength(1);
    expect(decl.panels[0]).toMatchObject({ id: 'mail', location: 'page', icon: 'lucide:mail' });
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'momo-plugin.json'), 'utf-8'));
    expect(() => validatePanelsAtRoot!(PLUGIN_ROOT, manifest, 'email')).not.toThrow();
  });

  it('index.html 含三栏挂载点与关键 service 方法锚点', () => {
    const html = fs.readFileSync(path.join(PLUGIN_ROOT, 'panel/index.html'), 'utf-8');
    for (const anchor of [
      'id="folders"', 'id="maillist"', 'id="reader"', 'id="account-form"',
      'accounts.add', 'accounts.test', 'accounts.delete',
      'mails.list', 'mails.refresh', 'mails.get',
      'drafts.send', 'drafts.discard',
    ]) {
      expect(html).toContain(anchor);
    }
    // HTML 邮件渲染必须走嵌套沙箱 iframe（spec §8/§11）
    expect(html).toContain('sandbox=""');
  });
});
