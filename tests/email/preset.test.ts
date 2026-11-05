// tests/email/preset.test.ts
// SKILL.md 宿主解析 + agent YAML 断言 + manifest 完整校验（此刻 tools/skills/agents 全在位，cross-ref 生效）
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { HOST_READY, hostImport, hostRequire } from '../host';
import { PLUGIN_ROOT } from './fixtures';

let parseSkillMd: ((md: string, dir: string) => { slug: string; name: string; description: string; body: string }) | null = null;
let validateManifest: ((m: unknown, root: string) => void) | null = null;
let yamlLoad: ((t: string) => Record<string, unknown>) | null = null;

describe.skipIf(!HOST_READY)('email 预置 skill/agent/manifest', () => {
  beforeAll(async () => {
    parseSkillMd = ((await hostImport('skill/loader.ts')) as unknown as { parseSkillMd: (md: string, dir: string) => { slug: string } }).parseSkillMd;
    validateManifest = ((await hostImport('plugin/manifest.ts')) as unknown as { validateManifest: (m: unknown, root: string) => void }).validateManifest;
    yamlLoad = hostRequire<{ load: (t: string) => Record<string, unknown> }>('js-yaml').load;
  });

  it('SKILL.md 解析通过且含关键章节', () => {
    const md = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/email-ops/SKILL.md'), 'utf-8');
    const def = parseSkillMd!(md, path.join(PLUGIN_ROOT, 'skills/email-ops'));
    expect(def.slug).toBe('email-ops');
    expect(def.body).toContain('发送契约');
    expect(def.body).toContain('错误处置');
  });

  it('agent YAML：七工具 ref 齐全 + defaultSkills=[email-ops] + 无 model 绑定', () => {
    const raw = yamlLoad!(fs.readFileSync(path.join(PLUGIN_ROOT, 'agents/email-assistant.yaml'), 'utf-8')) as {
      metadata?: { slug?: string };
      spec?: { declarative?: { systemPrompt?: string; model?: unknown; defaultTools?: Array<{ ref?: string }>; defaultSkills?: Array<{ ref?: string }> } };
    };
    expect(raw.metadata?.slug).toBe('email-assistant');
    expect(raw.spec?.declarative?.model).toBeUndefined();
    const refs = (raw.spec?.declarative?.defaultTools ?? []).map((t) => t.ref ?? '');
    for (const t of ['list_accounts', 'list_folders', 'list_mails', 'read_mail', 'save_attachment', 'draft_mail', 'send_draft']) {
      expect(refs).toContain(`plugin:email/${t}`);
    }
    expect(raw.spec?.declarative?.defaultSkills?.map((s) => s.ref)).toEqual(['email-ops']);
    expect(raw.spec?.declarative?.systemPrompt).toContain('确认');
  });

  it('manifest 通过完整 validateManifest（cross-ref：工具文件名 ↔ defaultTools、skills 子目录）', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'momo-plugin.json'), 'utf-8'));
    expect(() => validateManifest!(manifest, PLUGIN_ROOT)).not.toThrow();
  });
});
