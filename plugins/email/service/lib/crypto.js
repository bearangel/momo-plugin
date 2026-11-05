// 归档加密：MOMAIL1 头 + AES-256-GCM（spec 2026-11-05 §6）。
// AAD 绑定 accountId|folder|uid|version——文件互换与版本降级在认证层被拒。
// 主密钥由 archive 模块管理（keychain），本模块纯函数、无 IO。
'use strict';
const crypto = require('node:crypto');

const MAGIC = Buffer.from('MOMAIL1', 'utf8');
const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + 1 + IV_LEN + TAG_LEN;

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('归档主密钥必须是 32 字节 Buffer');
}

function seal(raw, key, aad) {
  assertKey(key);
  if (!Buffer.isBuffer(raw)) throw new Error('seal 入参必须是 Buffer');
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const ct = Buffer.concat([cipher.update(raw), cipher.final()]);
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]);
}

function open(sealed, key, aad) {
  assertKey(key);
  if (!Buffer.isBuffer(sealed) || sealed.length < HEADER_LEN) throw new Error('加密文件损坏（长度不足）');
  if (!sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('加密文件损坏（魔数不符）');
  const version = sealed[MAGIC.length];
  if (version !== VERSION) throw new Error(`加密文件版本不支持: ${version}`);
  const iv = sealed.subarray(MAGIC.length + 1, MAGIC.length + 1 + IV_LEN);
  const tag = sealed.subarray(MAGIC.length + 1 + IV_LEN, HEADER_LEN);
  const ct = sealed.subarray(HEADER_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  decipher.setAAD(Buffer.from(String(aad), 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error('加密文件认证失败（密钥不符或文件被篡改）');
  }
}

function generateMasterKey() {
  return crypto.randomBytes(32);
}

module.exports = { seal, open, generateMasterKey, MAGIC, HEADER_LEN };
