// tests/email/tools-write.test.ts
// save_attachment 记账链/双守门、draft_mail 25MB、send_draft 仅 draftId（Review Focus 3/4）
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

const load = (f: string): { createTools(pctx: unknown): {
  getDefs(): Array<{ name: string }>;
  handles(n: string): boolean;
  execute(n: string, args: Record<string, unknown>, ctx?: unknown): Promise<string>;
} } => require(path.resolve(__dirname, '../../plugins/email/tools', f));

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-tools-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

// 附件临时文件中转 mock（契约保真：service 真实行为=落盘后返回 tmpPath，不是内存 base64）
function relayAtt(content: Buffer, extra: Record<string, unknown> = {}) {
  const tmpPath = path.join(dir, `relay-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  fs.writeFileSync(tmpPath, content);
  return { tmpPath, filename: 'a.pdf', contentType: 'application/pdf', bytes: content.length, ...extra };
}

function makeCtx(service: Record<string, (p: unknown) => unknown> = {}) {
  const writes: Array<[string, string, string]> = [];
  const toolCtx = {
    wsFs: { assertInWorkspace: (rel: string) => path.join(dir, rel) },
    recordFileChange: async (name: string, rel: string, op: string) => { writes.push([name, rel, op]); },
    readTracker: { assertRead() {} },
    roomId: 'r', streamSessionId: 's',
  };
  const pctx = {
    getConfig: () => ({}), getDataDir: () => dir, logger: { info() {}, warn() {} },
    callService: async (method: string, params: unknown) => {
      if (method === 'attachments.get') {
        return service.attachments_get ? service.attachments_get(params) : relayAtt(Buffer.from('pdf-bytes'));
      }
      if (method === 'drafts.save') {
        return service.drafts_save ? service.drafts_save(params) : { id: 'draft_x', status: 'pending' };
      }
      if (method === 'drafts.send') {
        return service.drafts_send ? service.drafts_send(params) : { status: 'sent' };
      }
      throw new Error('unexpected ' + method);
    },
  };
  return { pctx, toolCtx, writes };
}

describe('save_attachment', () => {
  it('全链：中转文件 → 工作区落盘 → recordFileChange(create) → 中转文件已删', async () => {
    const { pctx, toolCtx, writes } = makeCtx();
    let relayPath = '';
    const pctx2 = { ...pctx, callService: async (method: string, params: unknown) => {
      const r = await pctx.callService(method, params);
      relayPath = (r as { tmpPath: string }).tmpPath;
      return r;
    } };
    const out = await load('save_attachment.js').createTools(pctx2).execute('save_attachment',
      { accountId: 'a', folder: 'INBOX', uid: 2, partId: '1.1', destPath: 'docs/a.pdf' }, toolCtx);
    const parsed = JSON.parse(out);
    expect(parsed.saved).toBe('docs/a.pdf');
    expect(fs.readFileSync(path.join(dir, 'docs/a.pdf')).toString()).toBe('pdf-bytes');
    expect(writes[0]).toEqual(['plugin:email/save_attachment', 'docs/a.pdf', 'create']);
    expect(fs.existsSync(relayPath)).toBe(false); // 拷贝完成即删中转文件
  });

  it('附件 >10MB 经中转正常保存（旧 10MB 双守门已随中转移除）', async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 7);
    const { pctx, toolCtx } = makeCtx({ attachments_get: async () => relayAtt(big, { filename: 'big' }) });
    const out = await load('save_attachment.js').createTools(pctx).execute('save_attachment',
      { accountId: 'a', folder: 'INBOX', uid: 1, partId: '1', destPath: 'big.bin' }, toolCtx);
    expect(JSON.parse(out).bytes).toBe(big.length);
    expect(fs.statSync(path.join(dir, 'big.bin')).size).toBe(big.length);
  });

  it('tmpPath 缺失 → 明确报错（服务契约不匹配不落盘）', async () => {
    const { pctx, toolCtx } = makeCtx({ attachments_get: async () => ({ filename: 'a', contentType: 'x', bytes: 1 }) });
    await expect(load('save_attachment.js').createTools(pctx).execute('save_attachment',
      { accountId: 'a', folder: 'INBOX', uid: 1, partId: '1', destPath: 'x' }, toolCtx)).rejects.toThrow('中转');
  });

  it('落盘失败也清理中转文件（finally 兜底）', async () => {
    const { pctx } = makeCtx();
    let relayPath = '';
    const pctx2 = { ...pctx, callService: async (method: string, params: unknown) => {
      const r = await pctx.callService(method, params);
      relayPath = (r as { tmpPath: string }).tmpPath;
      return r;
    } };
    // wsFs 校验抛错 → 拷贝前失败：工具应在拿到 tmpPath 后、门禁失败时也清理
    await expect(load('save_attachment.js').createTools(pctx2).execute('save_attachment',
      { accountId: 'a', folder: 'INBOX', uid: 1, partId: '1', destPath: 'x' },
      { wsFs: { assertInWorkspace: () => { throw new Error('outside workspace'); } } })).rejects.toThrow('workspace');
    expect(fs.existsSync(relayPath)).toBe(false);
  });

  it('缺 wsFs 注入 → 明确报错不降级', async () => {
    const { pctx } = makeCtx();
    await expect(load('save_attachment.js').createTools(pctx).execute('save_attachment',
      { accountId: 'a', folder: 'INBOX', uid: 1, partId: '1', destPath: 'x' }, {})).rejects.toThrow('wsFs');
  });
});

describe('draft_mail', () => {
  it('工作区附件读取 → base64 组装 → drafts.save；25MB 累计拒绝', async () => {
    const { pctx, toolCtx } = makeCtx();
    fs.writeFileSync(path.join(dir, 'att.bin'), Buffer.from('bin'));
    const tools = load('draft_mail.js').createTools(pctx);
    const out = await tools.execute('draft_mail',
      { accountId: 'a', to: 'x@y.z', subject: 'S', text: 'T', attachments: ['att.bin'] }, toolCtx);
    expect(JSON.parse(out).draftId).toBe('draft_x');
    fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(26 * 1024 * 1024));
    await expect(tools.execute('draft_mail',
      { accountId: 'a', to: 'x@y.z', subject: 'S', text: 'T', attachments: ['big.bin'] }, toolCtx)).rejects.toThrow('25MB');
  });

  it('附件路径必须在工作区内（assertInWorkspace 抛错透传）', async () => {
    const { pctx, toolCtx } = makeCtx();
    const tools = load('draft_mail.js').createTools(pctx);
    await expect(tools.execute('draft_mail',
      { accountId: 'a', to: 'x@y.z', subject: 'S', text: 'T', attachments: ['../evil.bin'] }, toolCtx)).rejects.toThrow();
  });
});

describe('send_draft', () => {
  it('仅认 draftId 转发，无收件人参数面；缺失拒绝', async () => {
    const { pctx } = makeCtx();
    let seenParams: unknown;
    const pctx2 = { ...pctx, callService: async (_m: string, params: unknown) => { seenParams = params; return { status: 'sent' }; } };
    const tools = load('send_draft.js').createTools(pctx2);
    await tools.execute('send_draft', { draftId: 'draft_x' });
    expect(seenParams).toEqual({ draftId: 'draft_x' });
    await expect(tools.execute('send_draft', {})).rejects.toThrow('draftId');
  });
});
