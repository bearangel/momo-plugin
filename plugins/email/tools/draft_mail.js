// draft_mail：起草邮件（存草稿，不发送）。附件 = 工作区相对路径数组（wsFs 边界 + 25MB 累计守门）。
'use strict';
const fs = require('node:fs');

const ATTACH_TOTAL_MAX = 25 * 1024 * 1024;

const DEF = {
  name: 'draft_mail',
  description: '起草邮件并存入草稿箱（不发送）。收件人/主题/正文在此时定型；附件用工作区相对路径。起草后必须在回复中展示完整内容并征求用户确认，确认后才可调用 send_draft。',
  inputSchema: {
    type: 'object',
    properties: {
      accountId: { type: 'string', description: '发件账号 id（缺省取第一个账号）' },
      to: { type: 'string', description: '收件人邮箱（多个用逗号分隔）' },
      cc: { type: 'string', description: '抄送（可省）' },
      subject: { type: 'string' },
      text: { type: 'string', description: '正文（纯文本）' },
      attachments: { type: 'array', items: { type: 'string' }, description: '工作区相对路径列表（总量 ≤25MB）' },
    },
    required: ['to', 'subject', 'text'],
  },
};
const splitAddrs = (v) => String(v || '').split(/[,，;；]/).map((s) => s.trim()).filter(Boolean);

module.exports.createTools = function createTools(pctx) {
  return {
    getDefs() { return [{ ...DEF }]; },
    getCatalog() { return [{ name: DEF.name, displayName: '起草邮件', description: DEF.description, category: '邮件', categoryEmoji: '', defaultOn: false }]; },
    handles(n) { return n === DEF.name; },
    async execute(n, args, ctx) {
      if (n !== DEF.name) throw new Error(`未知工具: ${n}`);
      const to = splitAddrs(args.to);
      if (to.length === 0) throw new Error('参数 to 缺失（至少一个收件人）');
      if (typeof ctx.wsFs?.assertInWorkspace !== 'function') {
        throw new Error('draft_mail 需要宿主注入 wsFs——请升级 Momo Studio');
      }
      const files = [];
      let total = 0;
      for (const rel of Array.isArray(args.attachments) ? args.attachments : []) {
        if (typeof rel !== 'string' || rel === '') continue;
        const abs = ctx.wsFs.assertInWorkspace(rel);
        const data = fs.readFileSync(abs);
        total += data.length;
        if (total > ATTACH_TOTAL_MAX) throw new Error(`附件总量超过 25MB 上限（已累计 ${total} 字节）`);
        files.push({ filename: rel.split('/').pop(), contentType: 'application/octet-stream', base64: data.toString('base64') });
      }
      const draft = await pctx.callService('drafts.save', {
        accountId: typeof args.accountId === 'string' && args.accountId !== '' ? args.accountId : '__first__',
        to, cc: splitAddrs(args.cc),
        subject: String(args.subject || ''), text: String(args.text || ''),
        attachments: files,
      });
      return JSON.stringify({
        draftId: draft.id, status: draft.status, to, subject: draft.subject,
        hint: '草稿已存入草稿箱——需用户明确确认后才能调用 send_draft（或用户在邮件面板手动发送）',
      }, null, 2);
    },
  };
};
