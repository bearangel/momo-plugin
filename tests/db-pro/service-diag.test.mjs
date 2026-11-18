// 终审 M3：node 缺失（ENOENT）不靠退避重试治愈——一次性判定 + 人话停机
import { describe, it, expect } from 'vitest';
import diag from '../../plugins/db-pro/service/spawn-diag.js';
const { isFatalSpawnError } = diag;

describe('isFatalSpawnError（M3）', () => {
  it('ENOENT = 致命（node 不在 PATH，重试无意义）', () => {
    expect(isFatalSpawnError(Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }))).toBe(true);
  });
  it('其他 spawn 错误（EACCES/未知）非致命——退避重试继续', () => {
    expect(isFatalSpawnError(Object.assign(new Error('EACCES'), { code: 'EACCES' }))).toBe(false);
    expect(isFatalSpawnError(new Error('随机错误'))).toBe(false);
    expect(isFatalSpawnError(null)).toBe(false);
  });
});
