'use strict';
// 骨架占位（Task 13/14 落实现）。
function createService(ctx) {
  return {
    async start() {
      ctx.logger.info('db-pro service 骨架启动（实现见 Task 13/14）');
    },
    async stop() {},
    async handle() {
      throw new Error('db-pro service 尚未实现（Task 13/14）');
    },
  };
}
module.exports = { createService };
