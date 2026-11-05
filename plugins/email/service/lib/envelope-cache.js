// 信封缓存：cache/<accountId>/<encodedFolder>.json，有界 500 条（最新 uid 在前）。
// 非真相源——读侧任何损坏返回 null 交上层重拉 IMAP。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MAX_ITEMS = 500;

function safeName(folder) {
  const segs = String(folder || '').split('/');
  if (String(folder).includes('\\') || segs.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`folder 名非法（拒绝路径段）: ${folder}`);
  }
  return segs.map(encodeURIComponent).join('/');
}

function normalizeEnvelopes(list) {
  return (Array.isArray(list) ? list : []).filter((e) => e && Number.isInteger(e.uid));
}

function createEnvelopeCache({ dataDir }) {
  const fileOf = (accountId, folder) => path.join(dataDir, 'cache', accountId, safeName(folder) + '.json');
  return {
    read(accountId, folder) {
      try {
        const parsed = JSON.parse(fs.readFileSync(fileOf(accountId, folder), 'utf-8'));
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
