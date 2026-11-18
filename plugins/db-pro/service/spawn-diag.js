'use strict';
// 引擎 spawn 失败分类（终审 M3）：node 可执行缺失（ENOENT）是环境性缺陷，
// 退避重试不可治愈——须一次性人话报错并停机；其他错误（权限/瞬时）仍走退避。
function isFatalSpawnError(err) {
  return err !== null && err !== undefined && err.code === 'ENOENT';
}

module.exports = { isFatalSpawnError };
