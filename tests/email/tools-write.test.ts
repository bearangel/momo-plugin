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
        return service.attachments_get ? service.attachments_get(params) : { filename: 'a.pdf', contentType: 'application/pdf', base64: Buffer.from('pdf-bytes').toString('base64') };
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
  it('全链：拉附件 → 工作区落盘 → recordFileChange(create)', async () => {
    const { pctx, toolCtx, writes } = makeCtx();
    const out = await load('save_attachment.js').createTools(pctx).execute('save_attachment',
      { accountId: 'a', folder: 'INBOX', uid: 2, partId: '1.1', destPath: 'docs/a.pdf' }, toolCtx);
    const parsed = JSON.parse(out);
    expect(parsed.saved).toBe('docs/a.pdf');
    expect(fs.readFileSync(path.join(dir, 'docs/a.pdf')).toString()).toBe('pdf-bytes');
    expect(writes[0]).toEqual(['plugin:email/save_attachment', 'docs/a.pdf', 'create']);
  });

  it('工具侧 10MB 双守门（service 放行也拒）', async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1);
    const { pctx, toolCtx } = makeCtx({ attachments_get: async () => ({ filename: 'big', contentType: 'x', base64: big.toString('base64') }) });
    await expect(load('save_attachment.js').createTools(pctx).execute('save_attachment',
      { accountId: 'a', folder: 'INBOX', uid: 1, partId: '1', destPath: 'big' }, toolCtx)).rejects.toThrow('10MB');
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
