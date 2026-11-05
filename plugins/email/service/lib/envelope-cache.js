// 信封缓存：委托 node:sqlite store（envelope_cache + meta），有界 500 条（最新 uid 在前）。
// 非真相源——读侧缺失返回 null 交上层重拉 IMAP；账号/文件夹名非法则抛错（不吞）。
'use strict';

const MAX_ITEMS = 500;

// 段消毒：folder 与 accountId 同款规则（拒绝反斜杠/空段/./..），防 RPC 侧 id 注入层级歧义。
function safeName(label, name) {
  const segs = String(name || '').split('/');
  if (String(name).includes('\\') || segs.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`${label} 名非法（拒绝路径段）: ${name}`);
  }
  return name;
}

function normalizeEnvelopes(list) {
  return (Array.isArray(list) ? list : []).filter((e) => e && Number.isInteger(e.uid));
}

function createEnvelopeCache({ store }) {
  return {
    read(accountId, folder) {
      // 消毒在读取前先行：非法 accountId/folder 的 throw 必须逃逸（不得被兜底吞成 null）。
      safeName('accountId', accountId);
      safeName('folder', folder);
      return store.readEnvelopes(accountId, folder);
    },
    write(accountId, folder, envelopes, opts) {
      safeName('accountId', accountId);
      safeName('folder', folder);
      store.writeEnvelopes(accountId, folder, normalizeEnvelopes(envelopes), opts);
    },
    invalidate(accountId, folder) {
      safeName('accountId', accountId);
      safeName('folder', folder);
      store.invalidateEnvelopes(accountId, folder);
    },
  };
}

module.exports = { createEnvelopeCache, MAX_ITEMS };
