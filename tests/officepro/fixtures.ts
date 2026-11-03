// office-pro 插件测试共享夹具：PLUGIN_ROOT 定位 + 假 vendor + 真 vendor 探测
// （自 momo-studio electron/tests/agent/tools/officepro/fixtures.ts 随迁，路径改本仓布局）。
import fs from 'node:fs';
import path from 'node:path';

export const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', 'plugins', 'office-pro');

/** 真 vendor 在位标记（scripts/build.sh npm install 后；generation-smoke / libs-port 消费） */
export const VENDOR_REAL = fs.existsSync(path.join(PLUGIN_ROOT, 'vendor', 'node_modules', 'pptxgenjs'));

const FAKE_NPM_LIBS = ['pptxgenjs', 'exceljs', 'docx', 'pdfkit', 'adm-zip'] as const;

/** 造假 vendor：npm 库假包 + momo-libs 假实现（跑 bootstrap/run_js 链路单测用） */
export function makeFakeVendor(root: string): void {
  for (const name of FAKE_NPM_LIBS) {
    const dir = path.join(root, 'node_modules', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0-fake', main: 'index.js' }));
    fs.writeFileSync(path.join(dir, 'index.js'), `module.exports = { FAKE: '${name}' };\n`);
  }
  for (const name of ['momo-chart', 'momo-pptx-zip', 'momo-validate']) {
    const dir = path.join(root, 'momo-libs', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.js'), `module.exports = { FAKE: '${name}' };\n`);
  }
}
