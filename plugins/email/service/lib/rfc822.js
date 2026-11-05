// RFC822 原始报文生成：streamTransport 渲染一次拿 Buffer（APPEND Drafts/Sent 用）。
'use strict';

// 只改头部字节（latin1 一对一映射），不触碰正文——附件二进制不受影响；Date 行之后逐行插入。
function injectHeaders(raw, extraHeaders) {
  const entries = Object.entries(extraHeaders).filter(([k, v]) => k && v != null);
  if (!Buffer.isBuffer(raw) || entries.length === 0) return raw;
  const boundary = raw.includes('\r\n\r\n') ? '\r\n\r\n' : '\n\n';
  const bodyStart = raw.indexOf(boundary);
  if (bodyStart < 0) return raw;
  const eol = boundary === '\r\n\r\n' ? '\r\n' : '\n';
  const safe = ([k, v]) => `${String(k).replace(/[\r\n]/g, '')}: ${String(v).replace(/[\r\n]/g, '')}`;
  const lines = raw.subarray(0, bodyStart).toString('latin1').split(eol);
  const dateAt = lines.findIndex((l) => /^Date:/i.test(l));
  lines.splice(dateAt >= 0 ? dateAt + 1 : 0, 0, ...entries.map(safe));
  return Buffer.concat([Buffer.from(lines.join(eol) + eol, 'latin1'), raw.subarray(bodyStart)]);
}

/** attachments: [{ filename, contentType, data: Buffer }]；extraHeaders 逐行插在 Date 之后 */
async function renderRawMail({ nodemailerLib, from, to, cc, subject, text, attachments, extraHeaders }) {
  const transport = nodemailerLib.createTransport({ streamTransport: true, buffer: true });
  const msg = await transport.sendMail({
    from, to, cc, subject, text,
    attachments: (attachments || []).map((a) => ({
      filename: a.filename, contentType: a.contentType, content: a.data,
    })),
  });
  const raw = msg.message; // Buffer（完整 RFC822）
  return extraHeaders ? injectHeaders(raw, extraHeaders) : raw;
}

module.exports = { renderRawMail };
