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
const BROWSER12 = [
  'browser_navigate', 'browser_snapshot', 'browser_screenshot', 'browser_click',
  'browser_type', 'browser_press_key', 'browser_hover', 'browser_scroll',
  'browser_evaluate', 'browser_console_messages', 'browser_tabs', 'browser_close',
];

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

  // web 验证闭环（2026-11-09 三次评估）：浏览器给执行组三家全量；docs-writer 仅截图两件
  it('结构性断言：浏览器 12 件套仅执行组三家；docs-writer 仅 navigate+screenshot', () => {
    for (const slug of Object.keys(EXPECTED)) {
      const hit = refsOf(slug).filter((r) => BROWSER12.includes(r));
      if (slug === 'implementer' || slug === 'test-engineer' || slug === 'debugger') {
        expect(hit, slug).toHaveLength(BROWSER12.length);
      } else if (slug === 'docs-writer') {
        expect(hit, slug).toEqual(['browser_navigate', 'browser_screenshot']);
      } else {
        expect(hit, `${slug} 不应持浏览器工具`).toHaveLength(0);
      }
    }
  });

  // 沙箱内 bash ps/kill 全 EPERM（宿主 process-tools.ts）：起 dev server 者必须能自管进程
  it('结构性断言：进程 3 件套仅执行组三家', () => {
    for (const slug of Object.keys(EXPECTED)) {
      const hit = refsOf(slug).filter((r) => PROCESS3.includes(r));
      const want = slug === 'implementer' || slug === 'test-engineer' || slug === 'debugger' ? PROCESS3.length : 0;
      expect(hit, slug).toHaveLength(want);
    }
  });
});
