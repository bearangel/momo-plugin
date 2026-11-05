// RFC822 原始报文生成：streamTransport 渲染一次拿 Buffer（APPEND Drafts/Sent 用）。
'use strict';
const crypto = require('node:crypto');

const MESSAGE_ID_DOMAIN = 'momo-studio.local';

// 只改头部字节（latin1 一对一映射），不触碰正文——附件二进制不受影响。
// Message-ID 必须在 Date 之后且全局唯一（QQ IMAP APPEND 缺它直接 Command failed）。
function injectHeaders(raw, extraHeaders, generatedMessageId) {
  if (!Buffer.isBuffer(raw)) return raw;
  const boundary = raw.includes('\r\n\r\n') ? '\r\n\r\n' : '\n\n';
  const bodyStart = raw.indexOf(boundary);
  if (bodyStart < 0) return raw;
  const eol = boundary === '\r\n\r\n' ? '\r\n' : '\n';
  const safe = ([k, v]) => `${String(k).replace(/[\r\n]/g, '')}: ${String(v).replace(/[\r\n]/g, '')}`;
  // 调用方传入的 Message-ID 优先；并从额外头里摘除，避免与生成值重复。
  let messageId = generatedMessageId;
  const extras = [];
  for (const [k, v] of Object.entries(extraHeaders || {})) {
    if (!k || v == null) continue;
    if (k.toLowerCase() === 'message-id') { messageId = String(v); continue; }
    extras.push([k, v]);
  }
  // 移除 transport 自带 Message-ID：保证全报文只有一条，且位置由本函数统一控制。
  const lines = raw.subarray(0, bodyStart).toString('latin1').split(eol)
    .filter((l) => !/^Message-ID:/i.test(l));
  const dateAt = lines.findIndex((l) => /^Date:/i.test(l));
  lines.splice(dateAt >= 0 ? dateAt + 1 : 0, 0, `Message-ID: ${messageId}`, ...extras.map(safe));
  return Buffer.concat([Buffer.from(lines.join(eol) + eol, 'latin1'), raw.subarray(bodyStart)]);
}

/** attachments: [{ filename, contentType, data: Buffer }]；Message-ID 与 extraHeaders 逐行插在 Date 之后 */
async function renderRawMail({ nodemailerLib, from, to, cc, subject, text, attachments, extraHeaders }) {
  const transport = nodemailerLib.createTransport({ streamTransport: true, buffer: true });
  const msg = await transport.sendMail({
    from, to, cc, subject, text,
    attachments: (attachments || []).map((a) => ({
      filename: a.filename, contentType: a.contentType, content: a.data,
    })),
  });
  const raw = msg.message; // Buffer（完整 RFC822）
  return injectHeaders(raw, extraHeaders, `<${crypto.randomUUID()}@${MESSAGE_ID_DOMAIN}>`);
}

module.exports = { renderRawMail };
