// tests/devteam/agents-parse.test.ts
// 8 个 agent YAML 过宿主真 parser + slug 唯一不撞既有 + 工具 ref 全在内置全集（spec 2026-11-09 §9）
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { HOST_READY, hostImport } from '../host';
import { PLUGIN_ROOT } from './fixtures';

const AGENT_SLUGS = [
  'code-explorer', 'code-reviewer', 'arch-advisor', 'implementer',
  'test-engineer', 'debugger', 'dev-lead', 'docs-writer',
] as const;

// 宿主与既有插件已占 slug（碰撞 → agent-sync 注册冲突）
const TAKEN_SLUGS = ['general-assistant', 'email-assistant', 'code-navigator', 'office-pro'];

interface ParsedDef {
  slug: string;
  systemPrompt: string;
  modelName: string;
  modelProviderId: string | null;
  defaultTools: Array<{ ref: string }>;
  defaultSkills: Array<{ ref: string }>;
}

let parse: ((yaml: string) => { def: ParsedDef }) | null = null;
let allBuiltinTools: string[] = [];

describe.skipIf(!HOST_READY)('dev-team agents 解析锁', () => {
  beforeAll(async () => {
    parse = ((await hostImport('agent/manifest-parser.ts')) as unknown as {
      parseAgentManifestWithSuggestion(yaml: string): { def: ParsedDef };
    }).parseAgentManifestWithSuggestion;
    allBuiltinTools = ((await hostImport('agent/tools/catalog.ts')) as unknown as {
      ALL_BUILTIN_TOOLS: string[];
    }).ALL_BUILTIN_TOOLS;
  });

  const parseSlug = (slug: string) =>
    parse!(fs.readFileSync(path.join(PLUGIN_ROOT, 'agents', `${slug}.yaml`), 'utf-8'));

  it('8 个 YAML 齐全、宿主 parser 实解析通过、slug 唯一且不撞既有', () => {
    const seen = new Set<string>();
    for (const slug of AGENT_SLUGS) {
      const { def } = parseSlug(slug);
      expect(def.slug).toBe(slug);
      expect(seen.has(def.slug), `slug 重复: ${def.slug}`).toBe(false);
      seen.add(def.slug);
      expect(TAKEN_SLUGS, `slug 碰撞: ${def.slug}`).not.toContain(def.slug);
    }
  });

  it('工具 ref 全部在宿主内置工具全集内（防拼写错被 dropUnknownToolRefs 静默滤掉）', () => {
    for (const slug of AGENT_SLUGS) {
      const { def } = parseSlug(slug);
      for (const t of def.defaultTools) {
        expect(allBuiltinTools, `${slug} 的工具 ref 不在内置全集: ${t.ref}`).toContain(t.ref);
      }
    }
  });

  it('defaultSkills=[dev-foundations,专册]；systemPrompt 完整；model 建议位在、绑定留空', () => {
    for (const slug of AGENT_SLUGS) {
      const { def } = parseSlug(slug);
      expect(def.defaultSkills.map((s) => s.ref)[0]).toBe('dev-foundations');
      expect(def.defaultSkills).toHaveLength(2);
      // 块标量缩进坏 → prompt 单行化，两个不同行的锚点不可能同时在
      expect(def.systemPrompt).toContain('先加载 dev-foundations');
      expect(def.systemPrompt).toContain('NEVER');
      expect(def.modelName.length).toBeGreaterThan(0);
      expect(def.modelProviderId).toBeNull(); // 绑定留空 → resolveModelBinding 走全局默认聊天模型
    }
  });
});
