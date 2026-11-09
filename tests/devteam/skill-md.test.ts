// tests/devteam/skill-md.test.ts
// 9 册 SKILL.md 在位 + 宿主 parseSkillMd 可解析 + 基座与专册关键内容锁（spec 2026-11-09 §7/§9）
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { HOST_READY, hostImport } from '../host';
import { PLUGIN_ROOT } from './fixtures';

let parseSkillMd: ((md: string, dir: string) => { slug: string; body: string }) | null = null;

/** 每册必含关键词（与计划内 SKILL.md 草稿逐字对应，防漂移删节） */
const SKILLS: Array<{ slug: string; keywords: string[] }> = [
  { slug: 'dev-foundations', keywords: ['证据先行', '最小改动', '文件:行', '不臆造', '验证证据', '先确认'] },
  { slug: 'code-exploration', keywords: ['定位策略', '结构讲解', '溯源', '转介'] },
  { slug: 'review-checklist', keywords: ['检查单', '判级', '输出模板'] },
  { slug: 'architecture-consulting', keywords: ['权衡表', '需用户确认', '查证'] },
  { slug: 'implementation-discipline', keywords: ['先读后改', '最小 diff', 'conventional', '不中间提交', '浏览器自检', 'process_kill'] },
  { slug: 'testing-discipline', keywords: ['先红后绿', 'mock 保真', '专项用例', 'E2E 走查'] },
  { slug: 'debugging-workflow', keywords: ['复现', '假设', '证据链', '三段报告'] },
  { slug: 'delegation-playbook', keywords: ['拆解', '派发单', '选角', '验收', '收口', '分支管理'] },
  { slug: 'docs-writing', keywords: ['受众', '大纲', '示例', '截图', '更新优先'] },
];

describe.skipIf(!HOST_READY)('dev-team skills', () => {
  beforeAll(async () => {
    parseSkillMd = ((await hostImport('skill/loader.ts')) as unknown as {
      parseSkillMd: (md: string, dir: string) => { slug: string; body: string };
    }).parseSkillMd;
  });

  it('9 册齐全且宿主 parseSkillMd 可解析（frontmatter 合法）', () => {
    expect(SKILLS).toHaveLength(9);
    for (const s of SKILLS) {
      const p = path.join(PLUGIN_ROOT, 'skills', s.slug, 'SKILL.md');
      expect(fs.existsSync(p), `缺 ${p}`).toBe(true);
      expect(() => parseSkillMd!(fs.readFileSync(p, 'utf-8'), path.dirname(p))).not.toThrow();
    }
  });

  it('基座与专册关键内容在位（逐册逐关键词）', () => {
    for (const s of SKILLS) {
      const dir = path.join(PLUGIN_ROOT, 'skills', s.slug);
      const { body } = parseSkillMd!(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8'), dir);
      for (const kw of s.keywords) expect(body, `${s.slug} 缺「${kw}」`).toContain(kw);
    }
  });
});
