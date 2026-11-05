// RFC822 原始报文生成：streamTransport 渲染一次拿 Buffer（APPEND Drafts/Sent 用）。
'use strict';

/** attachments: [{ filename, contentType, data: Buffer }] */
async function renderRawMail({ nodemailerLib, from, to, cc, subject, text, attachments }) {
  const transport = nodemailerLib.createTransport({ streamTransport: true, buffer: true });
  const msg = await transport.sendMail({
    from, to, cc, subject, text,
    attachments: (attachments || []).map((a) => ({
      filename: a.filename, contentType: a.contentType, content: a.data,
    })),
  });
  return msg.message; // Buffer（完整 RFC822）
}

module.exports = { renderRawMail };
