// read_mail：读单封邮件全文（200KB 截断保护 + 附件清单）。
'use strict';
const DEF = {
  name: 'read_mail',
  description: '读取单封邮件完整内容：正文（纯文本优先，>200KB 截断）+ 附件清单（partId/文件名/大小）。附件本体用 save_attachment 保存到工作区。超 2MB 的邮件会被拒收——改用 save_attachment。',
  inputSchema: {
    type: 'object',
    properties: {
      accountId: { type: 'string' }, folder: { type: 'string' }, uid: { type: 'number', description: 'list_mails 返回的邮件 uid' },
    },
    required: ['accountId', 'folder', 'uid'],
  },
};
module.exports.createTools = function createTools(pctx) {
  return {
    getDefs() { return [{ ...DEF }]; },
    getCatalog() { return [{ name: DEF.name, displayName: '读邮件', description: DEF.description, category: '邮件', categoryEmoji: '', defaultOn: false }]; },
    handles(n) { return n === DEF.name; },
    async execute(n, args) {
      if (n !== DEF.name) throw new Error(`未知工具: ${n}`);
      // uid 优先校验：仅给 accountId 时应报 uid 缺失（而非 folder）
      if (typeof args.uid !== 'number' || !Number.isInteger(args.uid)) throw new Error('参数 uid 缺失或非整数');
      for (const k of ['accountId', 'folder']) {
        if (typeof args[k] !== 'string' || args[k] === '') throw new Error(`参数 ${k} 缺失`);
      }
      const mail = await pctx.callService('mails.get', { accountId: args.accountId, folder: args.folder, uid: args.uid });
      return JSON.stringify(mail, null, 2);
    },
  };
};
