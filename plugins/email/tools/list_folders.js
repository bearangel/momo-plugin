// list_folders：列出账号的邮箱文件夹树（INBOX/草稿/已发送/自定义）。
'use strict';
const DEF = {
  name: 'list_folders',
  description: '列出指定账号的邮箱文件夹（含 special-use 标记与草稿/已发送归位）。读草稿或核对已发送时先用本工具。',
  inputSchema: {
    type: 'object',
    properties: { accountId: { type: 'string', description: '账号 id（list_accounts 返回）' } },
    required: ['accountId'],
  },
};
module.exports.createTools = function createTools(pctx) {
  return {
    getDefs() { return [{ ...DEF }]; },
    getCatalog() { return [{ name: DEF.name, displayName: '邮箱文件夹树', description: DEF.description, category: '邮件', categoryEmoji: '', defaultOn: false }]; },
    handles(n) { return n === DEF.name; },
    async execute(n, args) {
      if (n !== DEF.name) throw new Error(`未知工具: ${n}`);
      if (typeof args.accountId !== 'string' || args.accountId === '') throw new Error('参数 accountId 缺失');
      const folders = await pctx.callService('folders.list', { accountId: args.accountId });
      return JSON.stringify(folders, null, 2);
    },
  };
};
