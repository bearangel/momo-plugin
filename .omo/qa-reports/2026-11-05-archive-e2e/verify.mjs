// 归档真机验收（spec §13）：CDP 9333 → 面板 frame；plugin.reload 重载 service 清内存态（LRU/文件夹缓存）。
// 相位：①setRoot→读信→密文文件 ②reload→删文件→自愈重下 ③retention 收紧→INBOX 清理、Sent 豁免
//      ④换根目录旧行不命中 ⑤面板存储区统计。证据写 ./evidence/。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const requireFromMooStudio = createRequire('/Users/stbearangel/dev/AiProject/moo-studio/package.json');
const { chromium } = requireFromMooStudio('playwright');

const ROOT1 = '/tmp/momo-archive-e2e-root1';
const ROOT2 = '/tmp/momo-archive-e2e-root2';
const EVID = path.join(import.meta.dirname, 'evidence');
fs.mkdirSync(EVID, { recursive: true });
for (const r of [ROOT1, ROOT2]) { fs.rmSync(r, { recursive: true, force: true }); fs.mkdirSync(r, { recursive: true }); }

const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = b.contexts()[0].pages().find((p) => p.url().includes('localhost:5173'));
if (!page.frames().some((x) => x !== page.mainFrame())) {
  await page.click('nav[aria-label="活动栏"] button[aria-label="邮件"]').catch(() => {});
}
async function frame() {
  for (let i = 0; i < 30; i++) {
    const f = page.frames().find((x) => x !== page.mainFrame());
    if (f) { try { await f.waitForSelector('#folders', { timeout: 1500 }); return f; } catch { /* iframe 重建中 */ } }
    await page.waitForTimeout(400);
  }
  throw new Error('panel frame 不可用');
}
const rpc = (method, params) => frame().then((f) => f.evaluate(({ m, p }) => window.call(m, p), { m: method, p: params }));
const reloadPlugin = () => page.evaluate((id) => window.api.plugin.reload(id), 'email');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const abs = path.join(dir, e.name);
  return e.isDirectory() ? walk(abs) : [abs];
});
const encFiles = (root) => walk(root).filter((p) => p.endsWith('.eml.enc'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const out = {};
// 干净起点：清归档索引（研发期验收；旧 rootId 脏行不参与断言）
{
  const { DatabaseSync } = requireFromMooStudio('node:sqlite');
  const db = new DatabaseSync(`${process.env.HOME}/.momo-studio/plugins/data/email/data.db`);
  db.exec('DELETE FROM local_archive');
  db.close();
}
await reloadPlugin();
await sleep(1500);
const accs = await rpc('accounts.list', {});
const qq = accs.find((a) => a.email.includes('qq.com'));
out.account = qq.email;
const fo = await rpc('folders.list', { accountId: qq.id });

// ① setRoot + 读 INBOX×1 + Sent×1 → 密文文件（reload 已清 LRU，读必落档）
await rpc('archive.setRoot', { path: ROOT1 });
const readOne = async (folder) => {
  const l = await rpc('mails.list', { accountId: qq.id, folder, page: 1, pageSize: 3 });
  const uid = l.items[0].uid;
  await rpc('mails.get', { accountId: qq.id, folder, uid });
  return { folder, uid };
};
const readA = await readOne('INBOX');
const readS = await readOne(fo.sent);
await sleep(900);
const files1 = encFiles(ROOT1);
out.phase1 = {
  files: files1.length,
  magic: files1[0] ? fs.readFileSync(files1[0]).subarray(0, 7).toString() : null,
  plainLeak: files1[0] ? fs.readFileSync(files1[0]).indexOf(Buffer.from('Subject')) === -1 : null,
};

// ② reload（清 service 内存 LRU）→ 删 INBOX 文件 → 重读自愈
await reloadPlugin();
await sleep(1500);
const before = encFiles(ROOT1).length;
const fileA = encFiles(ROOT1).find((p) => path.basename(p).startsWith(String(readA.uid) + '-'));
if (!fileA) throw new Error(`未找到 INBOX uid=${readA.uid} 的归档文件`);
fs.unlinkSync(fileA);
await rpc('mails.get', { accountId: qq.id, folder: 'INBOX', uid: readA.uid });
await sleep(900);
out.phase2 = { before, restored: encFiles(ROOT1).length === before };

// ③ retention 收紧（注入旧 msg_date）→ INBOX 行被清、Sent 行保留
const { DatabaseSync } = requireFromMooStudio('node:sqlite');
const db = new DatabaseSync(`${process.env.HOME}/.momo-studio/plugins/data/email/data.db`);
db.prepare('UPDATE local_archive SET msg_date = ? WHERE folder = ?').run(Date.now() - 40 * 86400000, 'INBOX');
db.prepare('UPDATE local_archive SET msg_date = ? WHERE folder = ?').run(Date.now() - 40 * 86400000, fo.sent);
db.close();
await rpc('accounts.update', { id: qq.id, patch: { retention: '1m' } });
await sleep(2000);
const st3 = await rpc('archive.getSettings', {});
const rows3 = await frame().then((f) => f.evaluate(() => window.call('drafts.list', {}).then(() => null)));
void rows3;
const db3 = new DatabaseSync(`${process.env.HOME}/.momo-studio/plugins/data/email/data.db`);
const remain = db3.prepare('SELECT folder, COUNT(*) n FROM local_archive GROUP BY folder').all();
db3.close();
out.phase3 = { files: st3.files, remain };
await rpc('accounts.update', { id: qq.id, patch: { retention: 'forever' } });

// ④ 换根：旧文件保留、旧行不命中、新读落新根（reload 清 LRU 保证新读落档）
const oldCount = walk(ROOT1).length;
await rpc('archive.setRoot', { path: ROOT2 });
await reloadPlugin();
await sleep(1500);
const fo2 = await rpc('folders.list', { accountId: qq.id });
void fo2;
const readD = await readOne('INBOX');
await sleep(900);
out.phase4 = {
  oldKept: walk(ROOT1).length === oldCount,
  newRootHasFiles: encFiles(ROOT2).some((p) => path.basename(p).startsWith(String(readD.uid) + '-')),
  uidD: readD.uid,
};

// ⑤ 面板存储区
const pf = await frame();
await pf.getByRole('button', { name: /存储/ }).click();
await sleep(700);
await page.screenshot({ path: path.join(EVID, 'panel-storage-modal.png') });
out.phase5 = { stats: (await pf.textContent('#st-stats'))?.trim(), path: await pf.inputValue('#st-path') };

console.log(JSON.stringify(out, null, 1));
await b.close();
