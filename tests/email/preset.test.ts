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

  it('agent YAML：spec 层七工具 ref + defaultSkills=[email-ops] + model 建议块', () => {
    const raw = yamlLoad!(fs.readFileSync(path.join(PLUGIN_ROOT, 'agents/email-assistant.yaml'), 'utf-8')) as {
      metadata?: { slug?: string };
      spec?: {
        declarative?: { systemPrompt?: string; model?: { provider?: string; model?: string } };
        defaultTools?: Array<{ ref?: string }>;
        defaultSkills?: Array<{ ref?: string }>;
      };
    };
    expect(raw.metadata?.slug).toBe('email-assistant');
    // 宿主跨引用校验（plugin/manifest.ts:216）与 parser（agent/manifest-parser.ts:86）都读 spec 层
    const refs = (raw.spec?.defaultTools ?? []).map((t) => t.ref ?? '');
    for (const t of ['list_accounts', 'list_folders', 'list_mails', 'read_mail', 'save_attachment', 'draft_mail', 'send_draft']) {
      expect(refs).toContain(`plugin:email/${t}`);
    }
    expect(raw.spec?.defaultSkills?.map((s) => s.ref)).toEqual(['email-ops']);
    expect(raw.spec?.declarative?.model).toMatchObject({ provider: 'anthropic' });
    expect(raw.spec?.declarative?.systemPrompt).toContain('确认');
  });

  it('宿主 parseAgentManifestWithSuggestion 实解析：八工具入库 + 模型绑定留空（走全局默认）', async () => {
    const mod = (await hostImport('agent/manifest-parser.ts')) as unknown as {
      parseAgentManifestWithSuggestion(yaml: string): {
        def: {
          slug: string;
          defaultTools: Array<{ ref: string }>;
          defaultSkills: Array<{ ref: string }>;
          modelProviderId: string | null;
        };
      };
    };
    const { def } = mod.parseAgentManifestWithSuggestion(
      fs.readFileSync(path.join(PLUGIN_ROOT, 'agents/email-assistant.yaml'), 'utf-8'),
    );
    expect(def.slug).toBe('email-assistant');
    expect(def.defaultTools).toHaveLength(8); // read_file + 七个 plugin:email/* 工具
    expect(def.defaultTools.map((t) => t.ref)).toContain('plugin:email/send_draft');
    expect(def.defaultSkills.map((s) => s.ref)).toEqual(['email-ops']);
    expect(def.modelProviderId).toBeNull(); // 绑定留空 → resolveModelBinding 走全局默认聊天模型
  });

  it('manifest 通过完整 validateManifest（cross-ref：工具文件名 ↔ defaultTools、skills 子目录）', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'momo-plugin.json'), 'utf-8'));
    expect(() => validateManifest!(manifest, PLUGIN_ROOT)).not.toThrow();
  });
});
