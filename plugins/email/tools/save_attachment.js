// save_attachment：邮件附件保存到工作区（wsFs 边界 + 变更记账；10MB 双守门第二道）。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ATTACH_MAX = 10 * 1024 * 1024;

const DEF = {
  name: 'save_attachment',
  description: '把邮件附件保存到当前工作区指定路径（相对路径）。单附件 ≤10MB。覆盖已存在文件需先读过该文件（Read-before-Edit 门禁）。',
  inputSchema: {
    type: 'object',
    properties: {
      accountId: { type: 'string' }, folder: { type: 'string' }, uid: { type: 'number' },
      partId: { type: 'string', description: 'read_mail 返回的附件 partId' },
      destPath: { type: 'string', description: '工作区相对路径（如 docs/报告.pdf）' },
    },
    required: ['accountId', 'folder', 'uid', 'partId', 'destPath'],
  },
};
module.exports.createTools = function createTools(pctx) {
  return {
    getDefs() { return [{ ...DEF }]; },
    getCatalog() { return [{ name: DEF.name, displayName: '附件存工作区', description: DEF.description, category: '邮件', categoryEmoji: '', defaultOn: false }]; },
    handles(n) { return n === DEF.name; },
    async execute(n, args, ctx) {
      if (n !== DEF.name) throw new Error(`未知工具: ${n}`);
      for (const k of ['accountId', 'folder', 'partId', 'destPath']) {
        if (typeof args[k] !== 'string' || args[k] === '') throw new Error(`参数 ${k} 缺失`);
      }
      if (!Number.isInteger(args.uid)) throw new Error('参数 uid 缺失');
      if (typeof ctx.wsFs?.assertInWorkspace !== 'function') {
        throw new Error('save_attachment 需要宿主注入 wsFs（App 版本过旧或运行时未装配）——请升级 Momo Studio');
      }
      const att = await pctx.callService('attachments.get', { accountId: args.accountId, folder: args.folder, uid: args.uid, partId: args.partId });
      const buf = Buffer.from(String(att.base64 || ''), 'base64');
      if (buf.length > ATTACH_MAX) throw new Error(`附件超过 10MB 上限（${buf.length} 字节）`);
      const abs = ctx.wsFs.assertInWorkspace(args.destPath);
      const existed = fs.existsSync(abs);
      if (existed && ctx.readTracker && typeof ctx.readTracker.assertRead === 'function') {
        ctx.readTracker.assertRead(ctx.roomId, ctx.parentStreamSessionId, abs);
      }
      const before = existed ? fs.readFileSync(abs) : null;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      if (typeof ctx.recordFileChange === 'function') {
        ctx.recordFileChange('plugin:email/save_attachment', args.destPath, existed ? 'modify' : 'create', before, buf);
      }
      return JSON.stringify({ saved: args.destPath, bytes: buf.length, filename: att.filename }, null, 2);
    },
  };
};
