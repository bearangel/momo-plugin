// 草稿状态机：pending → sent | discarded（24h 过期）。真相链 = IMAP 目录 + drafts.json 登记。
// send 仅接受已存在草稿 id；收件人在起草时定型，envelope 透传自登记条目（门禁纵深 1）。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EXPIRE_MS = 24 * 3600 * 1000;
const ATTACH_TOTAL_MAX = 25 * 1024 * 1024;

function createDrafts({ dataDir, now = () => new Date(), renderMail, smtpSend, mailbox }) {
  const file = path.join(dataDir, 'drafts.json');
  const readAll = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return []; }
  };
  const writeAll = (rows) => {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  };
  const patch = (id, fn) => {
    const rows = readAll();
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) throw new Error(`草稿不存在: ${id}`);
    rows[i] = fn(rows[i]);
    writeAll(rows);
    return rows[i];
  };

  return {
    async save(input) {
      // input: { accountId, account, to: string[], cc: string[], subject, text, attachments: [{filename, contentType, data: Buffer}] }
      const total = (input.attachments || []).reduce((n, a) => n + (a.data ? a.data.length : 0), 0);
      if (total > ATTACH_TOTAL_MAX) throw new Error(`附件总量超过 25MB 上限（${total} 字节）`);
      const mailInput = {
        from: input.account.email, to: input.to, cc: input.cc || [],
        subject: input.subject, text: input.text, attachments: input.attachments || [],
      };
      const raw = await renderMail(mailInput);
      const folder = await mailbox.draftsFolder(input.accountId);
      const uid = await mailbox.append(input.accountId, folder, raw);
      const rec = {
        id: 'draft_' + crypto.randomUUID(), accountId: input.accountId, uid, status: 'pending',
        to: input.to, cc: input.cc || [], subject: input.subject, fromAddr: input.account.email,
        summary: String(input.text || '').slice(0, 120),
        attachmentNames: (input.attachments || []).map((a) => a.filename),
        inputPayload: {
          ...mailInput,
          attachments: (input.attachments || []).map((a) => ({
            filename: a.filename, contentType: a.contentType, dataBase64: a.data.toString('base64'),
          })),
        },
        createdAt: now().toISOString(), sentAt: null, lastError: null,
      };
      writeAll([...readAll(), rec]);
      return rec;
    },
    async list() { await this.sweep(); return readAll(); },
    async get(id) { return readAll().find((r) => r.id === id) || null; },
    async send(id) {
      const rec = readAll().find((r) => r.id === id);
      if (!rec) throw new Error(`草稿不存在: ${id}`);
      if (rec.status !== 'pending') throw new Error(`草稿状态为 ${rec.status}，不可发送`);
      try {
        const p = rec.inputPayload;
        const raw = await renderMail({
          ...p,
          attachments: (p.attachments || []).map((a) => ({
            filename: a.filename, contentType: a.contentType, data: Buffer.from(a.dataBase64, 'base64'),
          })),
        });
        await smtpSend(rec.accountId, raw, { from: rec.fromAddr, to: rec.to, cc: rec.cc });
        const sent = await mailbox.sentFolder(rec.accountId);
        await mailbox.append(rec.accountId, sent, raw).catch(() => undefined); // Sent 归档失败不阻断
        const draftsFolder = await mailbox.draftsFolder(rec.accountId);
        await mailbox.deleteMessage(rec.accountId, draftsFolder, rec.uid).catch(() => undefined);
        return patch(id, (r) => ({ ...r, status: 'sent', sentAt: now().toISOString(), lastError: null }));
      } catch (err) {
        const msg = String((err && err.message) || err);
        patch(id, (r) => ({ ...r, lastError: msg }));
        throw new Error(`发送失败（草稿已保留可重试）: ${msg}`);
      }
    },
    async discard(id) {
      const rec = readAll().find((r) => r.id === id);
      if (!rec) return;
      if (rec.status === 'pending') {
        const folder = await mailbox.draftsFolder(rec.accountId);
        await mailbox.deleteMessage(rec.accountId, folder, rec.uid).catch(() => undefined);
      }
      patch(id, (r) => ({ ...r, status: 'discarded' }));
    },
    async sweep() {
      const cutoff = now().getTime() - EXPIRE_MS;
      const rows = readAll();
      let dirty = false;
      for (const r of rows) {
        if (r.status === 'pending' && Date.parse(r.createdAt) < cutoff) {
          r.status = 'discarded';
          r.expireReason = '24h 未确认自动作废';
          dirty = true;
        }
      }
      if (dirty) writeAll(rows);
    },
  };
}

module.exports = { createDrafts, EXPIRE_MS };
