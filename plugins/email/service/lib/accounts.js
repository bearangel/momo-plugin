// 账号存储：accounts.json 元数据（无密码）+ ctx.secrets 凭据（keytar）。
// 纪律：密码永不入 JSON/日志/返回值；tmp+rename 原子写；读侧损坏丢弃重建。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TLS_MODES = ['tls', 'starttls'];
const PORT_MIN = 1;
const PORT_MAX = 65535;
const RETENTIONS = ['1m', '6m', '1y', 'forever'];
const DEFAULT_RETENTION = 'forever';

function checkRetention(value) {
  if (value !== undefined && !RETENTIONS.includes(value)) {
    throw new Error(`retention 非法（仅支持 ${RETENTIONS.join('/')}）: ${value}`);
  }
}

/** 常见邮箱预设（表单一键填充；仍可全自定义） */
const PRESETS = {
  qq: { imap: { host: 'imap.qq.com', port: 993, tlsMode: 'tls' }, smtp: { host: 'smtp.qq.com', port: 465, tlsMode: 'tls' } },
  '163': { imap: { host: 'imap.163.com', port: 993, tlsMode: 'tls' }, smtp: { host: 'smtp.163.com', port: 465, tlsMode: 'tls' } },
  gmail: { imap: { host: 'imap.gmail.com', port: 993, tlsMode: 'tls' }, smtp: { host: 'smtp.gmail.com', port: 465, tlsMode: 'tls' } },
  outlook: { imap: { host: 'outlook.office365.com', port: 993, tlsMode: 'tls' }, smtp: { host: 'smtp.office365.com', port: 587, tlsMode: 'starttls' } },
};

function presetFor(email) {
  const domain = String(email || '').split('@')[1] || '';
  if (domain === 'qq.com' || domain === 'foxmail.com') return PRESETS.qq;
  if (domain.endsWith('163.com')) return PRESETS['163'];
  if (domain === 'gmail.com') return PRESETS.gmail;
  if (domain.endsWith('outlook.com') || domain.endsWith('hotmail.com')) return PRESETS.outlook;
  return null;
}

function createAccountStore({ dataDir, secrets }) {
  const file = path.join(dataDir, 'accounts.json');
  const readAll = () => {
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  };
  const writeAll = (rows) => {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  };
  const checkEndpoint = (label, ep) => {
    if (!ep || typeof ep.host !== 'string' || ep.host.trim() === '') throw new Error(`${label}.host 不能为空`);
    if (!Number.isInteger(ep.port) || ep.port < PORT_MIN || ep.port > PORT_MAX) {
      throw new Error(`${label} 端口非法（${ep && ep.port}）`);
    }
    if (!TLS_MODES.includes(ep.tlsMode)) {
      throw new Error(`${label}.tlsMode 必须是 tls/starttls（明文连接拒绝）`);
    }
  };
  return {
    PRESETS, presetFor,
    async list() {
      return readAll().map(({ id, email, displayName, username, imap, smtp, createdAt, health, retention }) =>
        ({ id, email, displayName, username, imap, smtp, createdAt, health, retention: retention || DEFAULT_RETENTION }));
    },
    async get(id) { return readAll().find((r) => r.id === id) || null; },
    async add(input) {
      const rows = readAll();
      if (rows.some((r) => r.email === input.email)) throw new Error(`邮箱已存在: ${input.email}`);
      checkEndpoint('imap', input.imap);
      checkEndpoint('smtp', input.smtp);
      checkRetention(input.retention);
      const { password, ...meta } = input;
      const rec = {
        id: 'acc_' + crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        retention: input.retention || DEFAULT_RETENTION,
        health: { state: 'unknown' },
        ...meta,
        imap: { ...input.imap },
        smtp: { ...input.smtp },
      };
      rows.push(rec);
      // 凭据先行：secrets.set 成功后才落 JSON——JSON 写失败回滚凭据，避免「有密码无账号」残留。
      await secrets.set('account:' + rec.id, String(password || ''));
      try {
        writeAll(rows);
      } catch (err) {
        await secrets.delete('account:' + rec.id).catch(() => undefined);
        throw err;
      }
      return rec;
    },
    async update(id, patch) {
      const rows = readAll();
      const i = rows.findIndex((r) => r.id === id);
      if (i < 0) throw new Error(`账号不存在: ${id}`);
      if (patch.imap) checkEndpoint('imap', { ...rows[i].imap, ...patch.imap });
      if (patch.smtp) checkEndpoint('smtp', { ...rows[i].smtp, ...patch.smtp });
      checkRetention(patch.retention);
      const next = { ...rows[i], ...patch, id: rows[i].id, createdAt: rows[i].createdAt };
      // 非空密码才落 keychain；空串/未传 = 保留原值。密码永不入 JSON。
      if (typeof patch.password === 'string' && patch.password !== '') {
        await secrets.set('account:' + id, patch.password);
      }
      delete next.password;
      rows[i] = next;
      writeAll(rows);
      return next;
    },
    async remove(id) {
      const rows = readAll();
      const next = rows.filter((r) => r.id !== id);
      if (next.length === rows.length) return;
      writeAll(next);
      await secrets.delete('account:' + id).catch(() => undefined);
    },
    async setPassword(id, pw) { await secrets.set('account:' + id, pw); },
    async getPassword(id) { return secrets.get('account:' + id); },
    async markHealth(id, state, message) {
      const rows = readAll();
      const i = rows.findIndex((r) => r.id === id);
      if (i < 0) return;
      rows[i].health = { state, ...(message ? { message } : {}) };
      writeAll(rows);
    },
  };
}

module.exports = { createAccountStore, PRESETS, presetFor, RETENTIONS, DEFAULT_RETENTION };
