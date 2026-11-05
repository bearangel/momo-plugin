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
    // 未读数角标（spec §8）+ 测试通过才允许保存（spec §5.2）
    expect(html).toContain('unseen');
    expect(html).toContain('testOk');
  });

  it('面板沙箱合规：无原生 confirm/alert，自绘确认条 + 属性注入面收口 + 邮件 CSP', () => {
    const html = fs.readFileSync(path.join(PLUGIN_ROOT, 'panel/index.html'), 'utf-8');
    // C-1：宿主 iframe sandbox="allow-scripts" 无 allow-modals——window.confirm 恒 false、alert 静默丢
    expect(html).not.toMatch(/\bwindow\.confirm\b/);
    // 原 bug 的书写形态是裸 confirm(...)——补此锁（inlineConfirm/cancelConfirm 首字母大写，不误伤）
    expect(html).not.toMatch(/\bconfirm\s*\(/);
    expect(html).not.toMatch(/\balert\s*\(/);
    expect(html).toContain('id="confirm-bar"');
    expect(html).toContain('inlineConfirm');
    // N-1：删除目标以进入确认时为准的快照（防确认期间切账号删错）
    expect(html).toContain('targetId');
    // N-2：meta refresh 剥离（自导航不落 CSP 管辖）
    expect(html).toContain('refresh');
    // C-2：服务端可控文本（health.message / 文件夹路径）进属性须转义；内联 handler 不得拼 JS 串
    expect(html).toContain('attrEsc');
    expect(html).toContain('data-acc');
    expect(html).toContain('dataset.acc');
    expect(html).toContain('data-folder');
    expect(html).toContain('dataset.folder');
    expect(html).toContain('data-uid');
    expect(html).toContain('data-draft');
    expect(html).toContain('dataset.draft');
    // I-1：sandbox="" 不拦远程资源——HTML 邮件须自带 CSP 禁外链
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('img-src data: cid:');
  });
});
