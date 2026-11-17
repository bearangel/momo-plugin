'use strict';
// 骨架占位（Task 15 落全量 11 工具）：保证 manifest 校验与宿主加载通过。
function createTools() {
  return {
    getDefs: () => [],
    getCatalog: () => [],
    handles: () => false,
    execute: async () => {
      throw new Error('db-pro 工具面尚未实现（Task 15）');
    },
  };
}
module.exports = { createTools };
