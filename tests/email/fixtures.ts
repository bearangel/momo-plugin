// email 插件测试共享夹具（officepro/fixtures.ts 同款模式）
import fs from 'node:fs';
import path from 'node:path';

export const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', 'plugins', 'email');

/** vendor 在位标记（vendor 目录 npm install 后；service 集成用例消费） */
export const VENDOR_REAL = fs.existsSync(path.join(PLUGIN_ROOT, 'vendor', 'node_modules', 'imapflow'));
