// tests/email/crypto.test.ts
//
// 归档加密层（spec 2026-11-05 §6）：MOMAIL1 头 + AES-256-GCM，
// AAD 绑 accountId|folder|uid|version——文件互换/篡改/截断必须在认证层被拒。
import { describe, it, expect } from 'vitest';
import { seal, open, generateMasterKey, MAGIC, HEADER_LEN } from '../../plugins/email/service/lib/crypto';

const key = generateMasterKey();
const aad = 'acc1|INBOX|42|1';

describe('crypto seal/open', () => {
  it('round-trip：头结构与长度契约', () => {
    const raw = Buffer.from('From: a@b.c\r\nSubject: 你好\r\n\r\n正文\r\n', 'utf8');
    const sealed = seal(raw, key, aad);
    expect(sealed.subarray(0, 7).equals(MAGIC)).toBe(true);
    expect(sealed.length).toBe(raw.length + HEADER_LEN);
    expect(open(sealed, key, aad).equals(raw)).toBe(true);
  });

  it('同明文两次封装备随机 IV（密文不同）', () => {
    const raw = Buffer.from('x');
    expect(seal(raw, key, aad).equals(seal(raw, key, aad))).toBe(false);
  });

  it('AAD 篡改（换 uid）→ 认证失败', () => {
    const sealed = seal(Buffer.from('secret'), key, aad);
    expect(() => open(sealed, key, 'acc1|INBOX|43|1')).toThrow(/认证|失败/);
  });

  it('错误密钥 → 认证失败', () => {
    const sealed = seal(Buffer.from('secret'), key, aad);
    expect(() => open(sealed, generateMasterKey(), aad)).toThrow(/认证|失败/);
  });

  it('截断与魔数不符 → 损坏错误', () => {
    const sealed = seal(Buffer.from('secret'), key, aad);
    expect(() => open(sealed.subarray(0, sealed.length - 5), key, aad)).toThrow(/损坏/);
    expect(() => open(Buffer.concat([Buffer.from('XXXXXXX'), sealed.subarray(7)]), key, aad)).toThrow(/魔数/);
  });

  it('密钥长度校验（非 32 字节拒绝）', () => {
    expect(() => seal(Buffer.from('x'), Buffer.alloc(16), aad)).toThrow(/32/);
    expect(() => open(Buffer.alloc(HEADER_LEN), Buffer.alloc(8), aad)).toThrow(/32/);
  });
});
