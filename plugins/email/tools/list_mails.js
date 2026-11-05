// list_mails：分页列邮件（过滤：时间/未读/发件人/主题）。
'use strict';
const DEF = {
  name: 'list_mails',
  description: '列出账号某文件夹的邮件信封（分页，默认 20 条/页、上限 50）。过滤参数：since（YYYY-MM-DD）、unreadOnly、from、subject 关键词。摘要任务先用它圈定范围，忌直接 read_mail 全量读。',
  inputSchema: {
    type: 'object',
    properties: {
      accountId: { type: 'string', description: '账号 id' },
      folder: { type: 'string', description: '文件夹（缺省 INBOX）' },
      page: { type: 'number', description: '页码（缺省 1）' },
      pageSize: { type: 'number', description: '每页条数 1-50（缺省 20）' },
      filter: {
        type: 'object', description: '{ since?, unreadOnly?, from?, subject? }',
        properties: { since: { type: 'string' }, unreadOnly: { type: 'boolean' }, from: { type: 'string' }, subject: { type: 'string' } },
      },
    },
    required: ['accountId'],
  },
};
module.exports.createTools = function createTools(pctx) {
  // pageSize=0 须钳到 1（不是回退默认 20）——`|| 20` 会把 0 当缺省，故用 `?? 20`
  const clampSize = (v) => Math.min(Math.max(Math.trunc(Number(v ?? 20)) || 0, 1), 50);
  return {
    getDefs() { return [{ ...DEF }]; },
    getCatalog() { return [{ name: DEF.name, displayName: '邮件列表', description: DEF.description, category: '邮件', categoryEmoji: '', defaultOn: false }]; },
    handles(n) { return n === DEF.name; },
    async execute(n, args) {
      if (n !== DEF.name) throw new Error(`未知工具: ${n}`);
      if (typeof args.accountId !== 'string' || args.accountId === '') throw new Error('参数 accountId 缺失');
      const page = await pctx.callService('mails.list', {
        accountId: args.accountId,
        folder: typeof args.folder === 'string' && args.folder !== '' ? args.folder : 'INBOX',
        page: Math.max(Math.trunc(Number(args.page) || 1), 1),
        pageSize: clampSize(args.pageSize),
        filter: args.filter ?? {},
      });
      return JSON.stringify(page, null, 2);
    },
  };
};
