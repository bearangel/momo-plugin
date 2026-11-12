// tests/email/tools-readonly.test.ts
// 模块形状（文件名=短名）/ callService 转发 / pageSize 钳制 / 参数缺失中文错误
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const load = (f: string): { createTools(pctx: unknown): {
  getDefs(): Array<{ name: string; inputSchema: { type: string } }>;
  getCatalog(): Array<{ name: string }>;
  handles(n: string): boolean;
  execute(n: string, args: Record<string, unknown>, ctx?: unknown): Promise<string>;
} } => require(path.resolve(__dirname, '../../plugins/email/tools', f));

function fakeCtx() {
  const calls: Array<{ method: string; params: unknown; opts?: { timeoutMs?: number } }> = [];
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

  it('read_mail：agent 视图——无 html 面、text 30K 截断、imageCount/htmlChars 透出', async () => {
    const ctx = fakeCtx();
    ctx.callService = async (method: string, params: unknown) => {
      ctx.calls.push({ method, params });
      return {
        uid: 7, subject: 'S', from: 'a@b.c', to: 'x@y.z', date: '2026-11-11T00:00:00Z', seen: false,
        text: 'x'.repeat(40000), textChars: 40000, textTruncated: false,
        html: '<img src="data:image/png;base64,AAAA"><img src="b">', htmlChars: 12345, imageCount: 2,
        attachments: [{ partId: '1.1', filename: 'a.pdf', contentType: 'application/pdf', size: 3 }],
      };
    };
    const out = await load('read_mail.js').createTools(ctx).execute('read_mail', { accountId: 'a', folder: 'INBOX', uid: 7 });
    const v = JSON.parse(out);
    expect(v.imageCount).toBe(2);
    expect(v.htmlChars).toBe(12345);
    expect(v.textChars).toBe(40000);
    expect(v.textTruncated).toBe(true);
    expect(v.text).toContain('已截断');
    expect(v.text.length).toBeLessThanOrEqual(30000 + 60);
    expect(v.attachments).toHaveLength(1);
    expect(v).not.toHaveProperty('html');
    expect(JSON.stringify(v)).not.toContain('base64'); // 内嵌图片字节绝不过 agent 上下文
  });

  it('read_mail：短正文原样返回，不误标截断', async () => {
    const ctx = fakeCtx();
    ctx.callService = async (method: string, params: unknown) => {
      ctx.calls.push({ method, params });
      return { uid: 7, subject: 'S', from: 'a', to: 'b', date: 'd', seen: true, text: '正文', textChars: 2, htmlChars: 0, imageCount: 0, truncated: false, attachments: [] };
    };
    const v = JSON.parse(await load('read_mail.js').createTools(ctx).execute('read_mail', { accountId: 'a', folder: 'INBOX', uid: 7 }));
    expect(v.text).toBe('正文');
    expect(v.textTruncated).toBe(false);
    expect(v.imageCount).toBe(0);
  });

  it('read_mail：大邮件 deferred → 轮询收敛返回 agent 视图', async () => {
    vi.useFakeTimers();
    try {
      const ctx = fakeCtx();
      const view = { uid: 7, subject: 'S', from: 'a', to: 'b', date: 'd', seen: false, text: '正文', textChars: 2, htmlChars: 0, imageCount: 0, truncated: false, attachments: [] };
      const queue: unknown[] = [
        { deferred: true, uid: 7, sizeBytes: 21 * 1024 * 1024, estimateSec: 18 },
        { deferred: true, uid: 7, sizeBytes: 21 * 1024 * 1024, estimateSec: 18 },
        view,
      ];
      ctx.callService = async (method: string, params: unknown, opts?: { timeoutMs?: number }) => {
        ctx.calls.push({ method, params, opts });
        return queue.shift() ?? view;
      };
      const pending = load('read_mail.js').createTools(ctx).execute('read_mail', { accountId: 'a', folder: 'INBOX', uid: 7 });
      await vi.advanceTimersByTimeAsync(3000); // 第 1 次轮询
      await vi.advanceTimersByTimeAsync(3000); // 第 2 次轮询 → 命中视图
      const v = JSON.parse(await pending);
      expect(v.text).toBe('正文');
      expect(v.deferred).toBeUndefined();
      // 每次调用都带 patient + warmup + 30s 桥提示（宿主 A 项契约消费面）
      expect(ctx.calls[0]!.params).toMatchObject({ uid: 7, patient: true, warmup: true });
      for (const c of ctx.calls) expect(c.opts).toEqual({ timeoutMs: 30000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('read_mail：60s 预算耗尽仍 deferred → 结构化「转入中」状态（不 throw）', async () => {
    vi.useFakeTimers();
    try {
      const ctx = fakeCtx();
      let fetches = 0;
      ctx.callService = async () => { fetches += 1; return { deferred: true, uid: 7, sizeBytes: 21 * 1024 * 1024, estimateSec: 30 }; };
      const pending = load('read_mail.js').createTools(ctx).execute('read_mail', { accountId: 'a', folder: 'INBOX', uid: 7 });
      await vi.advanceTimersByTimeAsync(70000);
      const v = JSON.parse(await pending);
      expect(v.deferred).toBe(true);
      expect(v.timedOut).toBe(true);
      expect(v.message).toContain('转入');
      expect(fetches).toBeGreaterThanOrEqual(20); // 轮询确实在跑（3s 间隔 × ≥20 次）
    } finally {
      vi.useRealTimers();
    }
  });

  it('read_mail/list_folders：必填参数缺失 → 中文错误（不进 service）', async () => {
    const ctx = fakeCtx();
    await expect(load('read_mail.js').createTools(ctx).execute('read_mail', { accountId: 'a' })).rejects.toThrow('uid');
    await expect(load('list_folders.js').createTools(ctx).execute('list_folders', {})).rejects.toThrow('accountId');
  });
});
