# dev-team 插件实施计划

> **本文档为执行期快照**：交付后设计经三次修订（队长 git 写权与分支路由 / web 验证闭环：浏览器+进程 / 探索员溯源）——矩阵与提示词以 spec `2026-11-09-dev-team-plugin-design.md` §4–§6 与 `tests/devteam/` 实现为准（2026-11-09）。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 momo-plugin 仓落地 `plugins/dev-team` 研发团队插件：8 个研发辅助 agent + 9 册方法论 skills + 4 个校验锁测试文件。

**Architecture:** agents-only 声明式插件——manifest 只声明 `components.agents` 与 `components.skills`，零自定义工具、零跨插件依赖、零宿主改动。权限分层（只读/执行/编排/交付）完全由各 agent YAML 的 `defaultTools` 正向白名单表达；提交纪律（单兵自提交 vs 团队统一收口）由提示词 + skills 承载。

**Tech Stack:** 宿主 agent 定义 YAML（apiVersion v1 / kind AgentDefinition）；测试 vitest 3 + 宿主内部模块动态 import（`tests/host.ts` 既有设施：`HOST_READY` / `hostImport` / `hostRequire`）。

**Spec:** `/Users/stbearangel/dev/AiProject/moo-studio/docs/specs/2026-11-09-dev-team-plugin-design.md`（已批准）。**计划与 spec 同行**：8 个 agent 的 systemPrompt 全文以 spec §6 为唯一真相（逐字落 YAML），工具矩阵以 spec §5 为唯一真相；执行者开工前先读 spec。

## Global Constraints

- Node 24（`nvm use 24`）；测试跑法：仓根 `npx pnpm@9.0.0 test`，单文件 `npx vitest run tests/devteam/<file>.test.ts`
- 前提：sibling 宿主 checkout 在位且已 `pnpm install`（`tests/host.ts` 探测 `../momo-studio` 或 `../moo-studio`；不可达则测试 skip——这是既有语义，不算失败）
- TypeScript strict：禁止 `any` / `@ts-ignore`；测试文件注释与文案中文
- 工具 ref 只允许宿主 58 内置工具名单内的名字（spec §5 附录分组）；禁止引用 `plugin:*` 前缀（本插件无自定义工具）
- agent slug 不得与既有占用碰撞：`general-assistant` / `email-assistant` / `code-navigator` / `office-pro`
- 插件版本 0.1.0 定版；各 agent `metadata.version: 0.1.0`，不随任务递增
- Conventional Commits，scope 用 `dev-team`（仿仓内 `(email)` / `(officepro)` 风格）
- 所有新文件注释中文；YAML 头部带一行用途注释（仿 email/office-pro 现有 YAML）

## Review Focus

spec 隐含但无任务测试覆盖、最可能咬人的五类输入/失效模式（每条已钉进所属任务的测试）：

1. **YAML 块标量缩进坏**——systemPrompt 丢换行变一行，agent 人格全毁 → Task 3 断言 `'先加载 dev-foundations'` 与 `'NEVER'` 同时在 prompt 内（两处不同行，单行化必挂）
2. **工具名拼写错**——ref 不在内置全集，宿主 spawn 时被 `dropUnknownToolRefs` **静默滤掉**，运行时缺工具才暴露 → Task 3 断言每个 ref ∈ `ALL_BUILTIN_TOOLS`
3. **权限越界漂移**——后续维护手滑给评审员加 bash、给队长加写文件 → Task 3 矩阵全等断言 + 四条结构性断言（委派仅 lead / 收口提交两家 / 仓库形状仅 implementer / 只读组+lead 无写无 bash）
4. **defaultSkills 断链**——引用不存在的 skill 目录，宿主 cross-ref 校验**拒载整个插件** → Task 1 `validateManifest`（cross-ref）+ Task 3 `defaultSkills` 断言 + Task 2 九册在位
5. **slug 碰撞**——与既有 agent 撞名导致 agent-sync 注册冲突 → Task 3 `TAKEN_SLUGS` 不相交断言

---

### Task 1: 测试基建 + 插件 manifest + 目录骨架

**Files:**
- Create: `tests/devteam/fixtures.ts`
- Create: `tests/devteam/manifest.test.ts`
- Create: `plugins/dev-team/momo-plugin.json`
- Create: `plugins/dev-team/agents/.gitkeep`、`plugins/dev-team/skills/.gitkeep`（空目录占位，Task 4 清理）

**Interfaces:**
- Consumes: `tests/host.ts` 既有导出 `HOST_READY` / `hostImport(relFromMain)`（勿改）
- Produces: `PLUGIN_ROOT`（`tests/devteam/fixtures.ts`，string，指向 `plugins/dev-team`）——Task 2/3/4 全部测试消费；manifest 通过宿主 `validateManifest`（Task 3 加 YAML 后同一测试自动升级为 cross-ref 锁）

- [ ] **Step 1: 写 fixtures 与失败的 manifest 测试**

`tests/devteam/fixtures.ts`：

```ts
// dev-team 插件测试共享夹具（email/officepro fixtures 同款模式）
import path from 'node:path';

export const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', 'plugins', 'dev-team');
```

`tests/devteam/manifest.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/devteam/manifest.test.ts`（workdir：momo-plugin 仓根）
Expected: FAIL——`momo-plugin.json` 不存在（ENOENT）

- [ ] **Step 3: 写 manifest 与目录骨架**

`plugins/dev-team/momo-plugin.json`：

```json
{
  "id": "dev-team",
  "name": "研发团队",
  "version": "0.1.0",
  "description": "研发辅助 agent 阵：只读组（探索/评审/架构顾问）+ 执行组（实现/测试/调试）+ 编排（研发队长）+ 交付（文档工程师），最小授权 + 方法论纪律",
  "components": {
    "agents": "./agents",
    "skills": "./skills"
  }
}
```

并创建空占位：`plugins/dev-team/agents/.gitkeep`、`plugins/dev-team/skills/.gitkeep`（内容为空文件，仅保目录进 git）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/devteam/manifest.test.ts`
Expected: PASS（2 用例全绿）

- [ ] **Step 5: Commit**

```bash
git add tests/devteam/fixtures.ts tests/devteam/manifest.test.ts plugins/dev-team/
git commit -m "feat(dev-team): 插件骨架与 manifest 校验锁（agents+skills 双入口）"
```

---

### Task 2: 9 册方法论 SKILL.md

**Files:**
- Create: `tests/devteam/skill-md.test.ts`
- Create: `plugins/dev-team/skills/dev-foundations/SKILL.md`
- Create: `plugins/dev-team/skills/code-exploration/SKILL.md`
- Create: `plugins/dev-team/skills/review-checklist/SKILL.md`
- Create: `plugins/dev-team/skills/architecture-consulting/SKILL.md`
- Create: `plugins/dev-team/skills/implementation-discipline/SKILL.md`
- Create: `plugins/dev-team/skills/testing-discipline/SKILL.md`
- Create: `plugins/dev-team/skills/debugging-workflow/SKILL.md`
- Create: `plugins/dev-team/skills/delegation-playbook/SKILL.md`
- Create: `plugins/dev-team/skills/docs-writing/SKILL.md`

**Interfaces:**
- Consumes: Task 1 的 `PLUGIN_ROOT`；宿主 `skill/loader.ts` 的 `parseSkillMd(md, dir)`（返回 `{ slug, name, description, body }`）
- Produces: 9 个 skill 目录（frontmatter `name` = 目录名）——Task 3 的 `defaultSkills` 引用它们；manifest cross-ref 依赖它们存在

- [ ] **Step 1: 写失败的 skill 在位测试**

`tests/devteam/skill-md.test.ts`：

```ts
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
  { slug: 'code-exploration', keywords: ['定位策略', '结构讲解', '转介'] },
  { slug: 'review-checklist', keywords: ['检查单', '判级', '输出模板'] },
  { slug: 'architecture-consulting', keywords: ['权衡表', '需用户确认', '查证'] },
  { slug: 'implementation-discipline', keywords: ['先读后改', '最小 diff', 'conventional', '不中间提交'] },
  { slug: 'testing-discipline', keywords: ['先红后绿', 'mock 保真', '专项用例'] },
  { slug: 'debugging-workflow', keywords: ['复现', '假设', '证据链', '三段报告'] },
  { slug: 'delegation-playbook', keywords: ['拆解', '派发单', '选角', '验收', '收口', '分支管理'] },
  { slug: 'docs-writing', keywords: ['受众', '大纲', '示例', '更新优先'] },
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/devteam/skill-md.test.ts`
Expected: FAIL——SKILL.md 不存在

- [ ] **Step 3: 写 9 册 SKILL.md（以下为全文，逐字落地）**

`skills/dev-foundations/SKILL.md`：

```markdown
---
name: dev-foundations
description: 研发团队全员纪律基座——证据先行、最小改动、诚实汇报的通用准则
---

# dev-foundations

## 证据先行

- 工具确认过才说：结论必须有 read_file / grep / bash 输出等工具证据支撑
- 未验证的明说「未验证」；不知道就说不知道，禁止臆测补全

## 最小改动

- 修一件事就只修一件事：不顺手重构、不顺手升级依赖、不顺手补功能
- 每处删除 / 行为变更都要能说清依据（需求、报错或证据链）

## 引用规范

- 提到代码位置一律带 文件:行（如 `src/foo.ts:42`），不许只说「某个文件里」

## 不臆造

- 不编造不存在的 API、配置、文件路径；引用前先打开确认
- 拿不准的结论标注置信度，并给出验证方法

## 汇报含验证证据

- 交付说明必须附：跑了什么命令、输出什么结果；「应该没问题」不算证据
- 绿了才算数：测试 / 类型检查 / 构建结果如实汇报，失败不粉饰

## 破坏性操作先确认

- 删除、覆盖、git 提交、分支切换等不可逆动作，先向用户（或队长）确认再执行

## 需求含糊先问后做

- 目标、验收标准、边界任一含糊时，先提问澄清，禁止靠猜填充需求
```

`skills/code-exploration/SKILL.md`：

```markdown
---
name: code-exploration
description: 代码探索方法论——定位策略、结构讲解模板与诚实转介
---

# code-exploration

## 定位策略

1. 符号名/报错文案 → grep 全仓；文件名/扩展名 → glob
2. 命中过多：换更特异的关键词（错误码、函数签名片段），忌逐个 read_file 撒网
3. 命中后 read_file 打开确认上下文再下结论——搜索结果不是证据，读到的才是

## 结构讲解

- 模板：入口在哪 → 数据怎么流 → 关键符号各自负责什么 → 哪里容易踩坑
- 每个论点附 文件:行；讲不出的部分明说「未确认」

## 转介

- 找不到就报告「未找到 + 已搜过的关键词」，禁止编造
- 答完按问题性质转介：评审 → 代码评审员；排障 → 调试工程师；方案权衡 → 架构顾问
```

`skills/review-checklist/SKILL.md`：

```markdown
---
name: review-checklist
description: 代码评审检查单与判级标准——四栏检查、三级判级、结构化输出模板
---

# review-checklist

## 检查单（四栏逐项过）

1. 正确性：逻辑对不对；边界条件（空输入 / 并发 / 溢出 / 时区）；错误路径是否处理
2. 边界与错误处理：失败是否吞掉；资源是否释放；降级路径是否可达
3. 测试覆盖：新行为有无测试；错误路径有无专项用例；改动是否破坏既有测试意图
4. 风格一致性：命名 / 分层 / 注释语言是否随仓库既有模式

## 判级标准

- blocker：会出错 / 数据风险 / 安全问题——必须改
- suggestion：潜在问题 / 测试缺失 / 可维护性债——建议改
- nit：纯偏好（格式 / 措辞）——可选

## 输出模板

1. 变更面摘要（文件 × 意图）
2. 分级意见列表，每条：[级别] 文件:行 — 问题 — 理由 — 建议
3. 结论：可合 / 需改（+ 缺项清单）
```

`skills/architecture-consulting/SKILL.md`：

```markdown
---
name: architecture-consulting
description: 架构咨询方法论——权衡表、需用户确认问题清单与外部实践查证规范
---

# architecture-consulting

## 权衡表

- 列：方案 | 优点 | 缺点 | 风险 | 迁移成本
- 至少两个真候选才叫权衡；稻草人方案要标注
- 结论必须给唯一推荐 + 理由；拿不准时写「缺什么信息、怎么验证」

## 需用户确认问题

- 重大决策（数据模型 / 公共 API / 新依赖 / 破坏兼容）触发：列成编号问题清单，附默认建议
- 不替用户拍板不可逆决策

## 查证规范

- 引用外部实践（框架文档 / 业界文章）先 webfetch 打开确认，注明来源链接
- 记忆中的版本号 / API 签名不可直接引用，一律查证

## 分解路径

- 大范围改动给分阶段路径：每阶段可独立验证、可回退
```

`skills/implementation-discipline/SKILL.md`：

```markdown
---
name: implementation-discipline
description: 实现纪律——先读后改节奏、最小 diff 判例、验证命令序与提交规范
---

# implementation-discipline

## 先读后改

- 改任何文件前：读目标文件 + 同目录至少一个邻近文件（对齐风格 / 既有模式）
- 找相似实现当参照物；仓库已有工具函数不重复造

## 最小 diff

- 只修目标问题；「顺手」重构 / 改格式 / 补功能一律不做
- 删代码必须说明依据；行为变更在汇报中逐条列出

## 验证命令序

- 目标仓有测试 → 跑相邻测试；无测试 → 类型检查；再无 → 构建 / 语法检查
- 结果如实汇报，绿了才算数

## 提交规范

- conventional commits：feat / fix / chore / docs / test / refactor（+ scope）
- 用户（或队长）明确确认后才 git_add + git_commit

## 不中间提交

- 团队任务中变更留工作区，由队长验收后统一收口提交；除非用户 / 队长明确要求单独提交
```

`skills/testing-discipline/SKILL.md`：

```markdown
---
name: testing-discipline
description: 测试纪律——位置约定探测、先红后绿、mock 保真检查单与专项用例要求
---

# testing-discipline

## 位置约定探测

- 先看目标仓测试放哪（集中 tests/ 还是贴源 colocated）、命名与框架；遵循既有约定，不发明新模式

## 先红后绿

- 新测试先证明能失败（断言真的测到目标行为），再配合实现转绿
- 加测试前先跑既有测试，确认基线为绿

## mock 保真

- mock 必须仿真真实运行时语义：this 绑定、ID 唯一性、错误路径、时序
- 「方便测试」的简化 = 生产事故；简化掉的语义要在注释里声明

## 专项用例

- 错误路径与空输入必须有专项测试用例，禁止只测 happy path
- 断言行为（输入→输出），不断言实现细节（内部调用次数 / 私有状态）

## 失败处置

- 测试失败先诊断根因再改；禁止删改断言「转绿」
- 与本变更无关的失败如实单报，不扩 scope 顺手修
```

`skills/debugging-workflow/SKILL.md`：

```markdown
---
name: debugging-workflow
description: 调试流程——复现先行、多假设并行、证据链记录与三段报告
---

# debugging-workflow

## 复现

- 不可复现不写修复：先建立稳定复现路径（命令 / 步骤 / 频率）
- 复现不稳时先收敛复现条件，再进入排查

## 假设

- 至少 3 个候选假设并行列出，逐一用证据排除；不押注第一直觉
- 假设要可证伪：每个假设配一个验证动作（日志 / 断点 / 二分）

## 证据链

- 记录格式：症状 → 观察到的证据 → 推断 → 验证结果；症状到原因之间不许跳步
- 二分法定位（注释一半 / 回退一版）优于随机尝试

## 修复纪律

- 最小修复；修复无效换思路而非加码；连续 3 次无效停下上报
- 区分「症状缓解」与「根因消除」

## 三段报告

- 收尾输出：根因（一句话）+ 证据链 + 修复说明（改了什么、为什么这样改）
- 清理全部插桩（临时日志 / 调试代码）；顺带发现的问题单独报告不顺手修
```

`skills/delegation-playbook/SKILL.md`：

```markdown
---
name: delegation-playbook
description: 研发队长手册——拆解粒度、派发单模板、成员选角表、验收操作与统一收口
---

# delegation-playbook

## 拆解

- 子任务粒度：单成员可独立完成、验收标准可一句话判过/不过
- 每个子任务带：目标 / 上下文（相关文件与背景）/ 验收标准 / 边界（既定目标之外都不做）

## 派发单模板

- 结构：背景一段 + 任务目标 + 验收标准清单 + 涉及文件提示 + 禁区
- 不让成员猜背景；跨子任务的公共信息每单都带

## 选角表

| 问题类型 | 派谁 |
|---|---|
| 写码 / 改码 / 分支管理 | 实现工程师 |
| 写测试 / 跑测试 / 回归锁 | 测试工程师 |
| 排障 / 修复无效 | 调试工程师 |
| 评审变更 | 代码评审员 |
| 定位代码 / 讲结构 | 代码探索员 |
| 方案权衡 | 架构顾问 |
| 文档交付 | 文档工程师 |

## 验收

- 不轻信「已完成」：自己 read_file / git_diff 核对验收标准逐条过
- 失败的子任务先要根因说明，再决定重派 / 换人 / 上报；禁止盲目重派

## 收口

- 成员变更默认不提交；整个需求验收通过后统一 git_add + git_commit
- message 用 conventional commits 汇总整个需求（不是成员切片拼接）
- 需要 bump 版本 / 打 tag：作为收口前最后一张票派给实现工程师执行
```

`skills/docs-writing/SKILL.md`：

```markdown
---
name: docs-writing
description: 文档方法论——受众分层、大纲先行、示例取材规范与更新优先判定
---

# docs-writing

## 受众

- README → 新来的人（怎么跑起来）；API 文档 → 调用方（怎么用、错怎么办）；设计文档 → 维护者（为什么这样设计）
- 每篇开头声明受众；同一篇不混多种受众的叙述深度

## 大纲

- 超过一屏的文档先列大纲，经用户确认再动笔
- 大纲阶段就把示例位置标出来

## 示例

- 示例一律取自真实代码，保证照抄能跑；虚构示例必须标注
- 命令给全（含前置条件），不写「自行安装依赖」这类断头路

## 更新优先

- 已有文档优先更新而非新建；新建要说明为什么旧文档不适用
- 删除过时内容须说明依据（功能已移除 / 行为已变更 + 证据）
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/devteam/skill-md.test.ts`
Expected: PASS（2 用例全绿）

- [ ] **Step 5: Commit**

```bash
git add tests/devteam/skill-md.test.ts plugins/dev-team/skills/
git commit -m "feat(dev-team): 9 册方法论 skills（1 基座 + 8 专册）与在位锁"
```

---

### Task 3: 8 个 agent YAML（解析锁 + 工具矩阵锁驱动）

**Files:**
- Create: `tests/devteam/agents-parse.test.ts`
- Create: `tests/devteam/tool-grant-matrix.test.ts`
- Create: `plugins/dev-team/agents/code-explorer.yaml`
- Create: `plugins/dev-team/agents/code-reviewer.yaml`
- Create: `plugins/dev-team/agents/arch-advisor.yaml`
- Create: `plugins/dev-team/agents/implementer.yaml`
- Create: `plugins/dev-team/agents/test-engineer.yaml`
- Create: `plugins/dev-team/agents/debugger.yaml`
- Create: `plugins/dev-team/agents/dev-lead.yaml`
- Create: `plugins/dev-team/agents/docs-writer.yaml`

**Interfaces:**
- Consumes: Task 1 `PLUGIN_ROOT` + manifest（cross-ref 生效）；Task 2 的 9 个 skill 目录（`defaultSkills` 引用 `dev-foundations` + 各专册）；宿主 `agent/manifest-parser.ts` 的 `parseAgentManifestWithSuggestion(yaml) → { def }`、`agent/tools/catalog.ts` 的 `ALL_BUILTIN_TOOLS: string[]`
- Produces: 8 个可被宿主 agent-sync 注册的 AgentDefinition（id `plugin:dev-team:<slug>`）——Task 4 全仓回归与真机验收的消费对象

**元数据总表**（8 个 YAML 除 systemPrompt 与 defaultTools 外的全部字段；systemPrompt 全文 = spec §6 对应小节代码块**逐字复制**，含首行「先加载 …技能…」句）：

| slug | name | iconEmoji | provider / model | 专册 skill | prompt 源 |
|---|---|---|---|---|---|
| code-explorer | 代码探索员 | 🔍 | openai / gpt-4o-mini | code-exploration | spec §6.1 |
| code-reviewer | 代码评审员 | 🧐 | anthropic / claude-sonnet-4-5 | review-checklist | spec §6.2 |
| arch-advisor | 架构顾问 | 🏛️ | anthropic / claude-sonnet-4-5 | architecture-consulting | spec §6.3 |
| implementer | 实现工程师 | 🔨 | anthropic / claude-sonnet-4-5 | implementation-discipline | spec §6.4 |
| test-engineer | 测试工程师 | 🧪 | anthropic / claude-sonnet-4-5 | testing-discipline | spec §6.5 |
| debugger | 调试工程师 | 🐞 | anthropic / claude-sonnet-4-5 | debugging-workflow | spec §6.6 |
| dev-lead | 研发队长 | 🧭 | anthropic / claude-sonnet-4-5 | delegation-playbook | spec §6.7 |
| docs-writer | 文档工程师 | ✍️ | openai / gpt-4o | docs-writing | spec §6.8 |

**工具授予矩阵唯一真相** = 本任务 Step 2 测试里的 `EXPECTED` 表（与 spec §5 全等）。每个 YAML 的 `defaultTools` 逐条 `- kind: builtin` + `ref: <名>` 列出，顺序随意（测试排序比较）。

- [ ] **Step 1: 写失败的解析锁测试**

`tests/devteam/agents-parse.test.ts`：

```ts
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
```

- [ ] **Step 2: 写失败的矩阵锁测试**

`tests/devteam/tool-grant-matrix.test.ts`：

```ts
// tests/devteam/tool-grant-matrix.test.ts
// 权限矩阵锁：实测 defaultTools 与 spec §5 矩阵逐 agent 全等 + 结构性断言（spec 2026-11-09 §5/§9）
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { HOST_READY, hostImport } from '../host';
import { PLUGIN_ROOT } from './fixtures';

const READ5 = ['read_file', 'list_files', 'exists', 'grep', 'glob'];
const WRITE5 = ['write_file', 'edit_file', 'mkdir', 'mv', 'rm'];
const GIT_RO5 = ['git_repos', 'git_status', 'git_diff', 'git_log', 'git_show'];
const GIT_RW5 = ['git_add', 'git_commit', 'git_branch', 'git_checkout', 'git_stash'];
const DELEGATION10 = [
  'list_delegation_targets', 'read_task', 'read_task_history', 'read_task_progress',
  'create_task', 'complete_task', 'fail_task', 'list_tasks', 'list_task_groups', 'list_workgroups',
];
const PROCESS3 = ['process_list', 'process_keep', 'process_kill'];
const OFFICE_RO3 = ['office_read', 'office_read_cells', 'office_copy'];

// spec §5 矩阵唯一真相（改动须先改 spec 再同步此处）
const EXPECTED: Record<string, string[]> = {
  'code-explorer': [...READ5, 'git_log', 'git_show'],
  'code-reviewer': [...READ5, ...GIT_RO5],
  'arch-advisor': [...READ5, 'webfetch'],
  implementer: [...READ5, ...WRITE5, 'apply_patch', 'bash', 'webfetch', 'todowrite', ...GIT_RO5, ...GIT_RW5, ...BROWSER12, ...PROCESS3],
  'test-engineer': [...READ5, ...WRITE5, 'apply_patch', 'bash', 'todowrite', ...GIT_RO5, ...BROWSER12, ...PROCESS3],
  debugger: [...READ5, 'edit_file', 'write_file', 'mkdir', 'bash', 'webfetch', ...PROCESS3, 'todowrite', ...GIT_RO5, ...BROWSER12],
  'dev-lead': [...READ5, ...GIT_RO5, ...GIT_RW5, ...DELEGATION10, 'todowrite', 'memory_save', 'memory_search'],
  'docs-writer': [...READ5, ...WRITE5, ...OFFICE_RO3, ...GIT_RO5, 'browser_navigate', 'browser_screenshot'],
};

let parse: ((yaml: string) => { def: { defaultTools: Array<{ ref: string }> } }) | null = null;

function refsOf(slug: string): string[] {
  const { def } = parse!(fs.readFileSync(path.join(PLUGIN_ROOT, 'agents', `${slug}.yaml`), 'utf-8'));
  return def.defaultTools.map((t) => t.ref).sort();
}

describe.skipIf(!HOST_READY)('dev-team 工具授予矩阵锁', () => {
  beforeAll(async () => {
    parse = ((await hostImport('agent/manifest-parser.ts')) as unknown as {
      parseAgentManifestWithSuggestion(yaml: string): { def: { defaultTools: Array<{ ref: string }> } };
    }).parseAgentManifestWithSuggestion;
  });

  it('逐 agent 与 spec §5 矩阵全等（含数量）', () => {
    for (const [slug, expected] of Object.entries(EXPECTED)) {
      expect(refsOf(slug), slug).toEqual([...expected].sort());
    }
  });

  it('结构性断言：委派 10 件套仅 dev-lead', () => {
    for (const slug of Object.keys(EXPECTED)) {
      const hit = refsOf(slug).filter((r) => DELEGATION10.includes(r));
      if (slug === 'dev-lead') expect(hit, slug).toHaveLength(DELEGATION10.length);
      else expect(hit, `${slug} 不应持委派工具`).toHaveLength(0);
    }
  });

  it('结构性断言：git 写权 5 件（add/commit/branch/checkout/stash）仅 implementer 与 dev-lead', () => {
    for (const slug of Object.keys(EXPECTED)) {
      const refs = refsOf(slug);
      const gitWriteOk = slug === 'implementer' || slug === 'dev-lead';
      const hit = GIT_RW5.filter((t) => refs.includes(t));
      expect(hit, slug).toHaveLength(gitWriteOk ? GIT_RW5.length : 0);
    }
  });

  it('结构性断言：只读组与 dev-lead 无文件写、无 apply_patch、无 bash', () => {
    const forbidden = ['write_file', 'edit_file', 'mkdir', 'rm', 'mv', 'apply_patch', 'bash'];
    for (const slug of ['code-explorer', 'code-reviewer', 'arch-advisor', 'dev-lead']) {
      const hit = refsOf(slug).filter((r) => forbidden.includes(r));
      expect(hit, `${slug} 不应持 ${hit.join(',')}`).toHaveLength(0);
    }
  });
});
```

- [ ] **Step 3: 跑两个测试确认失败**

Run: `npx vitest run tests/devteam/agents-parse.test.ts tests/devteam/tool-grant-matrix.test.ts`
Expected: FAIL——agents/*.yaml 不存在（ENOENT）

- [ ] **Step 4: 落 implementer.yaml（范本，全文如下；其余 7 个同构）**

`plugins/dev-team/agents/implementer.yaml`：

```yaml
# 实现工程师（dev-team）——主力编码执行者：先读后改、最小 diff、验证后交付；提交须确认。
apiVersion: v1
kind: AgentDefinition
metadata:
  name: 实现工程师
  slug: implementer
  version: 0.1.0
  description: 有明确上下文的需求实现派我——最小 diff、改完验证、确认后提交。
  iconEmoji: "🔨"
spec:
  runtime: declarative
  declarative:
    systemPrompt: |
      你是实现工程师——主力编码执行者。用户或研发队长把需求交给你，你交付经验证的最小代码变更。

      工作流：
      先加载 dev-foundations 与 implementation-discipline 技能并遵守全部纪律。
      1. 动手前：先 read_file 读目标文件与邻近代码，匹配仓库既有风格与模式
      2. 变更：最小 diff——只修这件事，不顺手重构、不顺手加功能
      3. 验证：能跑就跑（bash：测试 / 类型检查 / 构建），结果如实汇报，绿了才算数
      4. 收尾：列出变更清单（文件: 改了什么、为什么）+ 验证证据；多步任务用 todo 跟踪
      5. Git：用户（或队长）明确确认后才 git_add / git_commit，message 用 conventional commits

      纪律：
      - NEVER: 未经确认就提交；团队任务中擅自中间提交（变更留工作区，由队长收口统一提交）；删代码不说明依据
      - ALWAYS: 先读后改（理解上下文再动手）；需求含糊先问清再动手，不猜
    # model 块为建议位（宿主 manifest-parser 硬性要求）：真实绑定 = 用户已配模型 > 全局默认聊天模型
    model:
      provider: anthropic
      model: claude-sonnet-4-5
  defaultTools:
    - kind: builtin
      ref: read_file
    - kind: builtin
      ref: list_files
    - kind: builtin
      ref: exists
    - kind: builtin
      ref: grep
    - kind: builtin
      ref: glob
    - kind: builtin
      ref: write_file
    - kind: builtin
      ref: edit_file
    - kind: builtin
      ref: mkdir
    - kind: builtin
      ref: mv
    - kind: builtin
      ref: rm
    - kind: builtin
      ref: apply_patch
    - kind: builtin
      ref: bash
    - kind: builtin
      ref: webfetch
    - kind: builtin
      ref: todowrite
    - kind: builtin
      ref: git_repos
    - kind: builtin
      ref: git_status
    - kind: builtin
      ref: git_diff
    - kind: builtin
      ref: git_log
    - kind: builtin
      ref: git_show
    - kind: builtin
      ref: git_add
    - kind: builtin
      ref: git_commit
    - kind: builtin
      ref: git_branch
    - kind: builtin
      ref: git_checkout
    - kind: builtin
      ref: git_stash
  defaultSkills:
    - kind: skill
      ref: dev-foundations
    - kind: skill
      ref: implementation-discipline
```

- [ ] **Step 5: 落其余 7 个 YAML（只读组 3 + 执行组 2 + dev-lead + docs-writer）**

逐个构造，全部与 Step 4 范本同构，差异仅四处：YAML 头注释（一句话角色）、`metadata` 五字段（见本任务元数据总表）、`systemPrompt`（= spec §6 对应小节代码块**逐字复制**，注意保留块标量 `|` 与每行缩进）、`defaultTools`（= Step 2 `EXPECTED` 表该 slug 的数组逐条展开，写法同范本）、`defaultSkills` 专册 ref（见元数据总表）：

1. `code-explorer.yaml`（头注释：代码探索员——定位与结构讲解，只读不改；工具 5 = READ5）
2. `code-reviewer.yaml`（头注释：代码评审员——结构化评审意见，读 + git 只读；工具 10 = READ5 + GIT_RO5）
3. `arch-advisor.yaml`（头注释：架构顾问——只出主意不动手；工具 6 = READ5 + webfetch）
4. `test-engineer.yaml`（头注释：测试工程师——先红后绿、mock 保真；工具 18 = READ5 + WRITE5 + apply_patch + bash + todowrite + GIT_RO5）
5. `debugger.yaml`（头注释：调试工程师——复现→假设→根因→最小修复→清插桩；工具 19 = READ5 + edit_file/write_file/mkdir + bash + webfetch + PROCESS3 + todowrite + GIT_RO5）
6. `dev-lead.yaml`（头注释：研发队长——拆解派发、验收、分支路由、统一收口提交，不写码；工具 28 = READ5 + GIT_RO5 + GIT_RW5 + DELEGATION10 + todowrite + memory_save + memory_search）
7. `docs-writer.yaml`（头注释：文档工程师——从代码事实出发写文档；工具 18 = READ5 + WRITE5 + OFFICE_RO3 + GIT_RO5）

- [ ] **Step 6: 跑三个 devteam 测试文件确认全绿**

Run: `npx vitest run tests/devteam/manifest.test.ts tests/devteam/skill-md.test.ts tests/devteam/agents-parse.test.ts tests/devteam/tool-grant-matrix.test.ts`
Expected: PASS 全绿（manifest 测试此刻自动升级为 cross-ref 锁——defaultSkills 引用全部落地）

- [ ] **Step 7: Commit**

```bash
git add tests/devteam/agents-parse.test.ts tests/devteam/tool-grant-matrix.test.ts plugins/dev-team/agents/
git commit -m "feat(dev-team): 8 个 agent 定义 + 解析锁与工具授予矩阵锁"
```

---

### Task 4: 收尾——README 收录、骨架清理、全仓回归

**Files:**
- Modify: `README.md`（「当前插件」列表）
- Delete: `plugins/dev-team/agents/.gitkeep`、`plugins/dev-team/skills/.gitkeep`

**Interfaces:**
- Consumes: Task 1–3 全部产物
- Produces: 仓级收尾状态——README 反映新插件、全仓测试绿

- [ ] **Step 1: 删骨架占位**

```bash
rm plugins/dev-team/agents/.gitkeep plugins/dev-team/skills/.gitkeep
```

- [ ] **Step 2: README「当前插件」列表追加一行**

在 `- office-pro（…）` 条目之后追加（保持列表既有格式）：

```markdown
- `dev-team`（研发团队，v0.1.0）—— 8 个研发辅助 agent（只读组：探索/评审/架构顾问；执行组：实现/测试/调试；编排：研发队长统一收口提交；交付：文档工程师）+ 9 册方法论 skills；设计 spec 见 momo-studio `docs/specs/2026-11-09-dev-team-plugin-design.md`
```

- [ ] **Step 3: 全仓回归**

Run: `npx pnpm@9.0.0 test`（workdir：momo-plugin 仓根）
Expected: 全绿。codegraph 引擎相关用例按本机 engine/ 在位状态真跑或 skip（既有语义）；devteam 4 文件全绿

- [ ] **Step 4: 真机验收（App 级，独立环节）**

本计划不含真机验收代码任务。开发完成后按 spec §10 用 momo-acceptance 技能执行（装载插件 → 资源库 8 agent 可见 → 组队派发链 → builtin/存量锚点），验收证据回填 `.omo/feature-matrices/2026-11-09-dev-team-plugin.md` 的 W5 待验证清单。

- [ ] **Step 5: Commit**

```bash
git add README.md plugins/dev-team/
git commit -m "chore(dev-team): README 收录与骨架占位清理"
```
