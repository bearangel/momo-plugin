// 草稿状态机：pending → sent | discarded（24h 过期）。真相链 = IMAP 目录 + drafts.json 登记。
// send 仅接受已存在草稿 id；收件人在起草时定型，envelope 透传自登记条目（门禁纵深 1）。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EXPIRE_MS = 24 * 3600 * 1000;
const ATTACH_TOTAL_MAX = 25 * 1024 * 1024;
const BODY_PREVIEW_MAX = 1000;

// 对外投影：剔除 inputPayload（正文/附件 base64）——面板与 LLM 只见摘要与预览。
function toView(rec) {
  return {
    id: rec.id, accountId: rec.accountId, status: rec.status,
    to: rec.to, cc: rec.cc, subject: rec.subject, summary: rec.summary,
    bodyPreview: String(rec.inputPayload?.text || '').slice(0, BODY_PREVIEW_MAX),
    attachmentNames: rec.attachmentNames,
    createdAt: rec.createdAt, sentAt: rec.sentAt, lastError: rec.lastError,
    expireReason: rec.expireReason ?? null,
  };
}

function createDrafts({ dataDir, now = () => new Date(), renderMail, smtpSend, mailbox, totalTimeoutMs = 8000 }) {
  const file = path.join(dataDir, 'drafts.json');
  const sending = new Set(); // I-2 in-flight 守卫：同一草稿 id 并发 send 拒绝
  // save/send 整链（folder 解析 + APPEND/SMTP/删草稿）总预算：必须先于 callService 桥 10s 报中文错误。
  const withTimeout = (label, p) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`草稿${label} 超时（${totalTimeoutMs}ms）`)), totalTimeoutMs);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
  const readAll = () => {
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return Array.isArray(v) ? v : [];
    } catch { return []; }
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
      return withTimeout('保存', (async () => {
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
        return toView(rec);
      })());
    },
    async list() { await this.sweep(); return readAll().map(toView); },
    async get(id) { return readAll().find((r) => r.id === id) || null; },
    async send(id) {
      return withTimeout('发送', (async () => {
      if (sending.has(id)) throw new Error('草稿正在发送中'); // I-2
      const rec = readAll().find((r) => r.id === id);
      if (!rec) throw new Error(`草稿不存在: ${id}`);
      if (rec.status !== 'pending') throw new Error(`草稿状态为 ${rec.status}，不可发送`);
      // M-3 发送前过期检查（不经 list/sweep 也会拦下；expireReason 与 sweep 同文）
      if (Date.parse(rec.createdAt) < now().getTime() - EXPIRE_MS) {
        patch(id, (r) => ({ ...r, status: 'discarded', expireReason: '24h 未确认自动作废' }));
        throw new Error('草稿已过期作废（24h 未确认）');
      }
      sending.add(id);
      try {
        let sent;
        let draftsFolder;
        let raw;
        try {
          // I-1 文件夹解析前置到 smtpSend 之前：此处失败 = 未发信的合法预检失败，可安全重试
          sent = await mailbox.sentFolder(rec.accountId);
          draftsFolder = await mailbox.draftsFolder(rec.accountId);
          const p = rec.inputPayload;
          raw = await renderMail({
            ...p,
            attachments: (p.attachments || []).map((a) => ({
              filename: a.filename, contentType: a.contentType, data: Buffer.from(a.dataBase64, 'base64'),
            })),
          });
          await smtpSend(rec.accountId, raw, { from: rec.fromAddr, to: rec.to, cc: rec.cc });
        } catch (err) {
          const msg = String((err && err.message) || err);
          patch(id, (r) => ({ ...r, lastError: msg }));
          throw new Error(`发送失败（草稿已保留可重试）: ${msg}`);
        }
        // ——— 此线以下邮件已物理发出：一切失败不得再产生「可重试」语义（I-1）———
        await mailbox.append(rec.accountId, sent, raw).catch(() => undefined); // Sent 归档失败不阻断
        await mailbox.deleteMessage(rec.accountId, draftsFolder, rec.uid).catch(() => undefined);
        try {
          return toView(patch(id, (r) => ({ ...r, status: 'sent', sentAt: now().toISOString(), lastError: null })));
        } catch (err) {
          const msg = String((err && err.message) || err);
          throw new Error(`发送已完成但登记失败: ${msg}（请勿重发，可在面板核对）`);
        }
      } finally {
        sending.delete(id);
      }
      })());
    },
    async discard(id) {
      const rec = readAll().find((r) => r.id === id);
      if (!rec) return;
      if (rec.status === 'sent') return; // M-1 终态不可越：已发送记录不删信不再改状态
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
