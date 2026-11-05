// send_draft：发送已确认草稿（仅 draftId——收件人不可在此指定，门禁纵深）。
'use strict';
const DEF = {
  name: 'send_draft',
  description: '发送指定草稿。【行为契约】仅当用户已明确确认发送（看过完整内容并同意）后才允许调用；禁止未经确认直接发送。草稿 id 来自 draft_mail 返回值。',
  inputSchema: {
    type: 'object',
    properties: { draftId: { type: 'string', description: 'draft_mail 返回的草稿 id' } },
    required: ['draftId'],
  },
};
module.exports.createTools = function createTools(pctx) {
  return {
    getDefs() { return [{ ...DEF }]; },
    getCatalog() { return [{ name: DEF.name, displayName: '发送草稿', description: DEF.description, category: '邮件', categoryEmoji: '', defaultOn: false }]; },
    handles(n) { return n === DEF.name; },
    async execute(n, args) {
      if (n !== DEF.name) throw new Error(`未知工具: ${n}`);
      if (typeof args.draftId !== 'string' || args.draftId === '') throw new Error('参数 draftId 缺失');
      const result = await pctx.callService('drafts.send', { draftId: args.draftId });
      return JSON.stringify(result, null, 2);
    },
  };
};
