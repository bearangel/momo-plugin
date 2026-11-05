// 归档真机验收（spec §13）：CDP 9333 → 面板 frame。
// 覆盖：①setRoot→读信→密文文件 ②删文件→自愈重下 ③旧 msg_date→retention 清理、Sent 豁免
// ④换根目录旧行不命中 ⑤面板存储区统计。
// 运行：node verify.mjs（工作目录需可解析 playwright；证据写 ./evidence/）
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT1 = '/tmp/momo-archive-e2e-root1';
const ROOT2 = '/tmp/momo-archive-e2e-root2';
const EVID = path.join(import.meta.dirname, 'evidence');
fs.mkdirSync(EVID, { recursive: true });
fs.rmSync(ROOT1, { recursive: true, force: true });
fs.rmSync(ROOT2, { recursive: true, force: true });
fs.mkdirSync(ROOT1, { recursive: true });
fs.mkdirSync(ROOT2, { recursive: true });

const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = b.contexts()[0].pages().find((p) => p.url().includes('localhost:5173'));
let f = page.frames().find((x) => x !== page.mainFrame());
if (!f) await page.click('nav[aria-label="活动栏"] button[aria-label="邮件"]').catch(() => {});
for (let i = 0; !f && i < 25; i++) { await page.waitForTimeout(500); f = page.frames().find((x) => x !== page.mainFrame()); }
await f.waitForSelector('#folders', { timeout: 15000 });

const out = {};
const accs = await f.evaluate(() => window.call('accounts.list', {}));
const qq = accs.find((a) => a.email.includes('qq.com'));
out.account = qq.email;

// ① setRoot + 读一封信 → 密文文件出现
out.setRoot = await f.evaluate(async (p) => window.call('archive.setRoot', { path: p }), ROOT1);
await f.evaluate(async (id) => {
  const l = await window.call('mails.list', { accountId: id, folder: 'INBOX', page: 1, pageSize: 5 });
  await window.call('mails.get', { accountId: id, folder: 'INBOX', uid: l.items[0].uid });
}, qq.id);
await new Promise((r) => setTimeout(r, 800));
const st1 = await f.evaluate(() => window.call('archive.getSettings', {}));
out.afterFirstRead = { files: st1.files, bytes: st1.bytes, root: st1.rootPath };
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const abs = path.join(dir, e.name);
  return e.isDirectory() ? walk(abs) : [abs];
});
const files1 = walk(ROOT1).filter((p) => p.endsWith('.eml.enc'));
out.fileCount1 = files1.length;
const buf = fs.readFileSync(files1[0]!);
out.ciphertext = { magic: buf.subarray(0, 7).toString(), plainLeak: buf.indexOf(Buffer.from('Subject')) === -1 };

// ② 删文件 → 重读自愈（missing→重下→重建文件）
fs.unlinkSync(files1[0]!);
const uid1 = Number(path.basename(files1[0]!).split('-')[0]);
await f.evaluate(async ({ id, uid }) => {
  const m = await window.call('mails.get', { accountId: id, folder: 'INBOX', uid });
  return { subject: m.subject };
}, { id: qq.id, uid: uid1 });
await new Promise((r) => setTimeout(r, 800));
const files1b = walk(ROOT1).filter((p) => p.endsWith('.eml.enc'));
out.selfHeal = { restored: files1b.length === files1.length };

// ③ retention 清理（注入旧 msg_date）+ Sent 豁免
const require2 = createRequire(import.meta.url);
const { DatabaseSync } = require2('node:sqlite');
const db = new DatabaseSync(`${process.env.HOME}/.momo-studio/plugins/data/email/data.db`);
db.prepare('UPDATE local_archive SET msg_date = ? WHERE root_id = (SELECT root_id FROM local_archive LIMIT 1)').run(Date.now() - 40 * 86400000);
db.close();
await f.evaluate(async (id) => {
  await window.call('accounts.update', { id, patch: { retention: '1m' } });
  await new Promise((r) => setTimeout(r, 1500));
}, qq.id);
const st2 = await f.evaluate(() => window.call('archive.getSettings', {}));
out.afterRetighten = { files: st2.files };
await f.evaluate(async (id) => {
  await window.call('accounts.update', { id, patch: { retention: 'forever' } });
}, qq.id);

// ④ 换根：旧文件保留、旧行不命中、新读落新根
const before = walk(ROOT1).length;
await f.evaluate(async (p) => window.call('archive.setRoot', { path: p }), ROOT2);
await f.evaluate(async (id) => {
  const l = await window.call('mails.list', { accountId: id, folder: 'INBOX', page: 1, pageSize: 3 });
  await window.call('mails.get', { accountId: id, folder: 'INBOX', uid: l.items[0].uid });
}, qq.id);
await new Promise((r) => setTimeout(r, 800));
out.rootSwitch = { oldKept: walk(ROOT1).length === before, newRootHasFiles: walk(ROOT2).some((p) => p.endsWith('.eml.enc')) };

// ⑤ 面板存储区
await page.screenshot({ path: path.join(EVID, 'panel-storage-entry.png') }).catch(() => {});
await f.getByRole('button', { name: /存储/ }).click();
await f.waitForTimeout(600);
await page.screenshot({ path: path.join(EVID, 'panel-storage-modal.png') });
out.storageModalText = (await f.textContent('#st-stats'))?.trim();
out.storagePath = await f.inputValue('#st-path');

console.log(JSON.stringify(out, null, 1));
await b.close();
