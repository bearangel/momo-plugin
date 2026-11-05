// tests/email/tools-readonly.test.ts
// 模块形状（文件名=短名）/ callService 转发 / pageSize 钳制 / 参数缺失中文错误
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const load = (f: string): { createTools(pctx: unknown): {
  getDefs(): Array<{ name: string; inputSchema: { type: string } }>;
  getCatalog(): Array<{ name: string }>;
  handles(n: string): boolean;
  execute(n: string, args: Record<string, unknown>, ctx?: unknown): Promise<string>;
} } => require(path.resolve(__dirname, '../../plugins/email/tools', f));

function fakeCtx() {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    getConfig: () => ({}),
    getDataDir: () => '/tmp/x',
    logger: { info() {}, warn() {} },
    callService: async (method: string, params: unknown) => { calls.push({ method, params }); return { ok: true }; },
  };
}

describe('只读工具', () => {
  it.each([
    ['list_accounts.js', 'list_accounts'],
    ['list_folders.js', 'list_folders'],
    ['list_mails.js', 'list_mails'],
    ['read_mail.js', 'read_mail'],
  ] as const)('%s：短名=文件名，schema object，handles 精确匹配', (file, name) => {
    const tools = load(file).createTools(fakeCtx());
    const defs = tools.getDefs();
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe(name);
    expect(defs[0]!.inputSchema.type).toBe('object');
    expect(tools.handles(name)).toBe(true);
    expect(tools.handles('other')).toBe(false);
    expect(tools.getCatalog()[0]!.name).toBe(name);
  });

  it('list_accounts：转发 accounts.list；返回 JSON 无 password 面', async () => {
    const ctx = fakeCtx();
    // 替换 callService 以注入账号数据；转发记录保留（否则 calls 断言无法成立）
    ctx.callService = async (method: string, params: unknown) => { ctx.calls.push({ method, params }); return [{ id: 'acc1', email: 'a@b.c', displayName: 'A', username: 'a@b.c', imap: {}, smtp: {}, health: { state: 'ok' } }]; };
    const out = await load('list_accounts.js').createTools(ctx).execute('list_accounts', {});
    expect(ctx.calls[0]!.method).toBe('accounts.list');
    expect(JSON.parse(out)[0]).not.toHaveProperty('password');
  });

  it('list_folders：转发 folders.list {accountId}', async () => {
    const ctx = fakeCtx();
    await load('list_folders.js').createTools(ctx).execute('list_folders', { accountId: 'acc1' });
    expect(ctx.calls[0]).toMatchObject({ method: 'folders.list', params: { accountId: 'acc1' } });
  });

  it('list_mails：pageSize 钳制 [1,50]，page 缺省 1，folder 缺省 INBOX', async () => {
    const ctx = fakeCtx();
    const tools = load('list_mails.js').createTools(ctx);
    await tools.execute('list_mails', { accountId: 'a', pageSize: 999 });
    expect(ctx.calls[0]!.params).toMatchObject({ pageSize: 50, page: 1, folder: 'INBOX' });
    await tools.execute('list_mails', { accountId: 'a', pageSize: 0 });
    expect((ctx.calls[1]!.params as { pageSize: number }).pageSize).toBe(1);
  });

  it('read_mail/list_folders：必填参数缺失 → 中文错误（不进 service）', async () => {
    const ctx = fakeCtx();
    await expect(load('read_mail.js').createTools(ctx).execute('read_mail', { accountId: 'a' })).rejects.toThrow('uid');
    await expect(load('list_folders.js').createTools(ctx).execute('list_folders', {})).rejects.toThrow('accountId');
  });
});
