// 新仓最小 vitest 配置（spec §3.2）：仅跑 tests/；server.fs.allow 放开父目录
// ——engine-harness / dev-install-probe 经动态 import 引用 sibling 宿主的
// .ts 源码，Vite 默认 fs 守卫只允许本仓根，须显式放开（Review Focus 3）。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { fs: { allow: ['..'] } },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
});
