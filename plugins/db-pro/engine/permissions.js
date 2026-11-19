'use strict';
// 逐连接权限位（spec 2026-11-19 §6.4）：配置态闸；人工批准为独立运行态闸。

const PERMISSION_BITS = ['query', 'insert', 'update', 'delete', 'ddl_table', 'ddl_other', 'procedure', 'script'];
const BIT_SET = new Set(PERMISSION_BITS);

const PRESETS = {
  read: ['query'],
  readwrite: ['query', 'insert', 'update', 'delete'],
  full: [...PERMISSION_BITS],
};

const LEGACY_FULL = [...PERMISSION_BITS];

/** 语句分类 → 所需权限位（session/txn 中性；priv 由通道直接拒绝） */
const CLASS_BITS = {
  read: ['query'],
  insert: ['insert'],
  update: ['update'],
  delete: ['delete'],
  merge: ['insert', 'update', 'delete'],
  ddl_table: ['ddl_table'],
  ddl_other: ['ddl_other'],
  procedure: ['procedure'],
  block: ['procedure'],
  session: [],
  txn: [],
  priv: [],
  unknown: [],
};

function normalizePermissions(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  for (const v of raw) {
    if (typeof v === 'string' && BIT_SET.has(v)) seen.add(v);
  }
  return PERMISSION_BITS.filter((b) => seen.has(b));
}

function requiredBitsForClass(cls) {
  return CLASS_BITS[cls] ?? [];
}

function hasBit(permissions, bit) {
  return Array.isArray(permissions) && permissions.includes(bit);
}

function missingBits(permissions, cls) {
  return requiredBitsForClass(cls).filter((b) => !hasBit(permissions, b));
}

module.exports = { PERMISSION_BITS, PRESETS, LEGACY_FULL, normalizePermissions, requiredBitsForClass, hasBit, missingBits };
