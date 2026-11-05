// 信封缓存：cache/<accountId>/<encodedFolder>.json，有界 500 条（最新 uid 在前）。
// 非真相源——读侧任何损坏返回 null 交上层重拉 IMAP；账号/文件夹名非法则抛错（不吞）。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MAX_ITEMS = 500;

// 段消毒：folder 与 accountId 同款规则（拒绝反斜杠/空段/./..），防 RPC 侧 id 注入路径穿越。
function safeName(label, name) {
  const segs = String(name || '').split('/');
  if (String(name).includes('\\') || segs.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`${label} 名非法（拒绝路径段）: ${name}`);
  }
  return segs.map(encodeURIComponent).join('/');
}

function normalizeEnvelopes(list) {
  return (Array.isArray(list) ? list : []).filter((e) => e && Number.isInteger(e.uid));
}

function createEnvelopeCache({ dataDir }) {
  const fileOf = (accountId, folder) => path.join(dataDir, 'cache', safeName('accountId', accountId), safeName('folder', folder) + '.json');
  return {
    read(accountId, folder) {
      // 消毒在 try 之外先行执行：非法 accountId/folder 的 throw 必须逃逸（不得被损坏兜底吞成 null）。
      const target = fileOf(accountId, folder);
      try {
        const parsed = JSON.parse(fs.readFileSync(target, 'utf-8'));
        if (!parsed || !Array.isArray(parsed.items)) return null;
        return parsed;
      } catch {
        return null;
      }
    },
    write(accountId, folder, envelopes) {
      // 保序纪律：≤500 条按调用方给定顺序原样存（IMAP 页序即展示序）；
      // 仅超界时按 uid 降序截断保留最新 500（brief 实现无条件排序会破坏页序，与本文件配套测试冲突，以此为准）。
      const normalized = normalizeEnvelopes(envelopes);
      const items = normalized.length > MAX_ITEMS
        ? normalized.sort((a, b) => b.uid - a.uid).slice(0, MAX_ITEMS)
        : normalized;
      const target = fileOf(accountId, folder);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = target + '.tmp-' + process.pid + '-' + Date.now();
      fs.writeFileSync(tmp, JSON.stringify({ items, savedAt: Date.now() }, null, 2), 'utf-8');
      fs.renameSync(tmp, target);
    },
  };
}

module.exports = { createEnvelopeCache, MAX_ITEMS };
