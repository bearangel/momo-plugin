'use strict';
// 连接存储（spec 2026-11-19 §6.1/§6.2）：元数据 connections.json（全局）；
// URL 明文只进 keytar（secrets 键 conn.<id>.url）。迁移旧 conn1–6 保等效全权限位。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { LEGACY_FULL, normalizePermissions, PRESETS } = require('../engine/permissions');

const FILE = 'connections.json';
const SCHEMES = new Set(['mysql', 'postgres', 'postgresql', 'oracle', 'dm', 'dameng']);

function newId() {
  return `c_${crypto.randomBytes(4).toString('hex')}`;
}

function dialectOf(url) {
  try {
    return new URL(url).protocol.replace(':', '');
  } catch {
    return 'unknown';
  }
}

function createConnectionsStore({ dataDir, secrets, log }) {
  const file = path.join(dataDir, FILE);
  const urlCache = new Map();

  function readAll() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeAll(records) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(records, null, 1) + '\n');
  }

  let records = readAll();

  function assertNameFree(name, exceptId) {
    if (records.some((r) => r.name === name && r.id !== exceptId)) throw new Error(`连接名 "${name}" 已存在——请换一个名称`);
  }

  function assertUrl(url) {
    let u;
    try { u = new URL(url); } catch { throw new Error('连接 URL 非法——示例：mysql://user:pass@host:3306/db'); }
    const scheme = u.protocol.replace(':', '');
    if (!SCHEMES.has(scheme)) throw new Error(`不支持的连接协议 "${scheme}://"（支持 mysql/postgres/oracle/dm）`);
  }

  function secretKey(id) { return `conn.${id}.url`; }

  /** 面板投影：不含 URL 明文（dialect/hasUrl 来自密钥缓存） */
  function listProjection() {
    return records.map((r) => {
      const cached = urlCache.get(r.id);
      return {
        id: r.id, name: r.name, description: r.description ?? '',
        permissions: r.permissions, isDefault: r.isDefault === true,
        dialect: cached ? dialectOf(cached) : 'unknown',
        hasUrl: cached !== undefined,
      };
    });
  }

  /** 预热密钥缓存（以 keytar 现状为准：删除/变更即时反映） */
  async function warm() {
    for (const r of records) {
      const url = await secrets.get(secretKey(r.id));
      if (url) urlCache.set(r.id, url);
      else urlCache.delete(r.id);
    }
  }

  async function listForEngine() {
    const out = [];
    for (const r of records) {
      const url = await secrets.get(secretKey(r.id));
      if (!url) {
        urlCache.delete(r.id);
        log('连接缺少密钥，已跳过', { id: r.id, name: r.name });
        continue;
      }
      urlCache.set(r.id, url);
      out.push({ name: r.name, url, permissions: r.permissions });
    }
    return out;
  }

  async function create(input) {
    const name = String(input.name ?? '').trim();
    if (name === '') throw new Error('连接名称不能为空');
    assertNameFree(name);
    const url = String(input.url ?? '').trim();
    if (url === '') throw new Error('连接 URL 不能为空');
    assertUrl(url);
    const id = newId();
    const permissions = normalizePermissions(input.permissions?.length ? input.permissions : PRESETS.read);
    const rec = {
      id, name, description: String(input.description ?? ''), permissions,
      isDefault: records.length === 0, createdAt: Date.now(), updatedAt: Date.now(),
    };
    await secrets.set(secretKey(id), url);
    urlCache.set(id, url);
    records = [...records, rec];
    writeAll(records);
    return rec;
  }

  async function update(id, patch) {
    const rec = records.find((r) => r.id === id);
    if (!rec) throw new Error('连接不存在');
    if (typeof patch.name === 'string') {
      const name = patch.name.trim();
      if (name === '') throw new Error('连接名称不能为空');
      assertNameFree(name, id);
      rec.name = name;
    }
    if (typeof patch.description === 'string') rec.description = patch.description;
    if (Array.isArray(patch.permissions)) rec.permissions = normalizePermissions(patch.permissions);
    if (typeof patch.url === 'string' && patch.url.trim() !== '') {
      assertUrl(patch.url.trim());
      await secrets.set(secretKey(id), patch.url.trim());
      urlCache.set(id, patch.url.trim());
    }
    rec.updatedAt = Date.now();
    writeAll(records);
    return rec;
  }

  async function remove(id) {
    if (!records.some((r) => r.id === id)) throw new Error('连接不存在');
    records = records.filter((r) => r.id !== id);
    await secrets.delete(secretKey(id));
    urlCache.delete(id);
    if (records.length > 0 && !records.some((r) => r.isDefault)) records[0].isDefault = true;
    writeAll(records);
  }

  async function setDefault(id) {
    if (!records.some((r) => r.id === id)) throw new Error('连接不存在');
    for (const r of records) r.isDefault = r.id === id;
    writeAll(records);
  }

  async function migrateLegacy(legacyConfig) {
    if (records.length > 0) return { migrated: 0 };
    const found = [];
    for (let i = 1; i <= 6; i += 1) {
      const url = typeof legacyConfig[`conn${i}_url`] === 'string' ? legacyConfig[`conn${i}_url`].trim() : '';
      if (url === '') continue;
      const rawName = legacyConfig[`conn${i}_name`];
      const name = typeof rawName === 'string' && rawName.trim() !== '' ? rawName.trim() : `conn${i}`;
      found.push({ name, url });
    }
    if (found.length === 0) return { migrated: 0 };
    const defName = typeof legacyConfig.default_connection === 'string' ? legacyConfig.default_connection.trim() : '';
    const next = [];
    for (const [idx, item] of found.entries()) {
      const id = newId();
      await secrets.set(secretKey(id), item.url);
      urlCache.set(id, item.url);
      next.push({
        id, name: item.name, description: '（自旧版配置迁移）', permissions: [...LEGACY_FULL],
        isDefault: defName ? item.name === defName : idx === 0,
        createdAt: Date.now(), updatedAt: Date.now(),
      });
    }
    records = next;
    if (!records.some((r) => r.isDefault)) records[0].isDefault = true;
    writeAll(records);
    for (let i = 1; i <= 6; i += 1) await secrets.delete(`conn${i}_url`).catch(() => undefined);
    return { migrated: records.length };
  }

  return { listProjection, listForEngine, warm, create, update, remove, setDefault, migrateLegacy };
}

module.exports = { createConnectionsStore };
