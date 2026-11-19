// tests/db-pro/permissions.test.mjs
// 逐连接权限位模型（spec 2026-11-19 §6.4）：8 位 + 预设档 + 分类映射。
import { describe, it, expect } from 'vitest';
import p from '../../plugins/db-pro/engine/permissions.js';
const { PERMISSION_BITS, PRESETS, normalizePermissions, requiredBitsForClass, missingBits, LEGACY_FULL, hasBit } = p;

describe('权限位模型', () => {
  it('8 位 + 预设档', () => {
    expect(PERMISSION_BITS).toHaveLength(8);
    expect(PRESETS.read).toEqual(['query']);
    expect(PRESETS.readwrite).toEqual(['query', 'insert', 'update', 'delete']);
    expect(PRESETS.full).toEqual(PERMISSION_BITS);
  });
  it('normalize：去未知位/去重/排序稳定', () => {
    expect(normalizePermissions(['script', 'query', 'bogus', 'query'])).toEqual(['query', 'script']);
    expect(normalizePermissions(undefined)).toEqual([]);
  });
  it('分类 → 所需位', () => {
    expect(requiredBitsForClass('read')).toEqual(['query']);
    expect(requiredBitsForClass('merge')).toEqual(['insert', 'update', 'delete']);
    expect(requiredBitsForClass('ddl_table')).toEqual(['ddl_table']);
    expect(requiredBitsForClass('block')).toEqual(['procedure']);
    expect(requiredBitsForClass('session')).toEqual([]);
    expect(requiredBitsForClass('priv')).toEqual([]);
  });
  it('missingBits 返回缺失集合', () => {
    expect(missingBits(['query'], 'insert')).toEqual(['insert']);
    expect(missingBits(PRESETS.full, 'ddl_table')).toEqual([]);
  });
  it('LEGACY_FULL = 全 8 位（迁移保等效）', () => {
    expect([...LEGACY_FULL].sort()).toEqual([...PERMISSION_BITS].sort());
  });
  it('hasBit', () => {
    expect(hasBit(['query', 'script'], 'script')).toBe(true);
    expect(hasBit(['query'], 'script')).toBe(false);
    expect(hasBit(undefined, 'query')).toBe(false);
  });
});
