// tests/email/service-rfc822.test.ts
// 真 vendor nodemailer streamTransport：Message-ID 生成/唯一/位置 + X-Momo-Draft-Id 共存
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLUGIN_ROOT, VENDOR_REAL } from './fixtures';

const requireHere = createRequire(import.meta.url);
const { renderRawMail } = requireHere(path.join(PLUGIN_ROOT, 'service/lib/rfc822.js')) as {
  renderRawMail(o: Record<string, unknown>): Promise<Buffer>;
};
const nodemailerLib = requireHere(path.join(PLUGIN_ROOT, 'vendor/node_modules/nodemailer'));

const BASE = {
  nodemailerLib, from: 'a@b.c', to: ['x@y.z'], cc: [], subject: 's', text: 't', attachments: [],
};

function headerOf(buf: Buffer): string {
  return buf.toString('latin1').replace(/\r\n/g, '\n');
}

describe('rfc822 render', () => {
  it('生成唯一 Message-ID，位于 Date 之后、X-Momo-Draft-Id 之前', async () => {
    if (!VENDOR_REAL) throw new Error('vendor 未安装：请在 plugins/email/vendor 执行 npm install');
    const raw = headerOf(await renderRawMail({ ...BASE, extraHeaders: { 'X-Momo-Draft-Id': 'draft_1' } }));
    expect(raw.match(/^Message-ID:/gim) ?? []).toHaveLength(1);
    expect(raw).toMatch(/^Message-ID: <[^>]+@momo-studio\.local>$/m);
    const dateAt = raw.indexOf('\nDate:');
    const midAt = raw.indexOf('\nMessage-ID:');
    const xAt = raw.indexOf('\nX-Momo-Draft-Id:');
    expect(dateAt).toBeGreaterThanOrEqual(0);
    expect(midAt).toBeGreaterThan(dateAt);
    expect(xAt).toBeGreaterThan(midAt);
    expect(raw).toContain('X-Momo-Draft-Id: draft_1');
  });

  it('每次渲染 Message-ID 唯一；调用方传入时优先且不重复', async () => {
    if (!VENDOR_REAL) throw new Error('vendor 未安装：请在 plugins/email/vendor 执行 npm install');
    const idOf = (s: string) => /^Message-ID: (.+)$/m.exec(s)?.[1];
    const a = headerOf(await renderRawMail({ ...BASE }));
    const b = headerOf(await renderRawMail({ ...BASE }));
    expect(idOf(a)).toBeTruthy();
    expect(idOf(a)).not.toBe(idOf(b));
    const custom = headerOf(await renderRawMail({ ...BASE, extraHeaders: { 'message-id': '<custom@x>' } }));
    expect(custom.match(/^Message-ID:/gim) ?? []).toHaveLength(1);
    expect(idOf(custom)).toBe('<custom@x>');
  });
});
