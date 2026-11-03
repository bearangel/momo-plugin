// tests/officepro/skill-md.test.ts（momo-plugin）
//
// SKILL.md 格式锁（spec 2026-11-03 §5.3）：frontmatter 必填字段 + 核心章节关键词。
// 自 momo-studio officepro 随迁：宿主 parseSkillMd 经动态 import（skipIf 容忍宿主缺失）。
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { HOST_READY, hostImport } from '../host';
import { PLUGIN_ROOT } from './fixtures';

interface SkillDef {
  slug: string;
  name: string;
  description: string;
  body: string;
}
let parseSkillMd: ((md: string, dir: string) => SkillDef) | null = null;

const skillDir = path.join(PLUGIN_ROOT, 'skills/office-authoring');

describe.skipIf(!HOST_READY)('office-authoring SKILL.md', () => {
  beforeAll(async () => {
    const mod = (await hostImport('skill/loader.ts')) as unknown as { parseSkillMd(md: string, dir: string): SkillDef };
    parseSkillMd = mod.parseSkillMd;
  });

  it('parseSkillMd 通过（frontmatter 完整）', () => {
    const def = parseSkillMd!(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8'), skillDir);
    expect(def.slug).toBe('office-authoring');
    expect(def.name).toBeTruthy();
    expect(def.description).toBeTruthy();
  });

  it('正文含核心章节（决策树 / footgun / 设计规范 / QA）', () => {
    const def = parseSkillMd!(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8'), skillDir);
    for (const keyword of ['路径决策', 'footgun', '设计规范', 'QA', 'momo-validate', 'outputs']) {
      expect(def.body).toContain(keyword);
    }
  });

  // charSpacing 事故防线（验收实锤：150/180 产出逐字竖排）——单位与安全范围必须写进 skill
  it('footgun 含 charSpacing 单位与安全范围', () => {
    const def = parseSkillMd!(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8'), skillDir);
    expect(def.body).toContain('charSpacing');
    expect(def.body).toMatch(/单位是 point/);
    expect(def.body).toMatch(/0–2|0-2/);
  });
});
