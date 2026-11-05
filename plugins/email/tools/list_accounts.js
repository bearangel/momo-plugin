// list_accounts：列出已配置邮箱账号（脱敏，无凭据）。
'use strict';
const DEF = {
  name: 'list_accounts',
  description: '列出用户已配置的全部邮箱账号（id、邮箱地址、显示名、健康状态）。返回不含任何凭据。摘要/群发类任务先调用本工具确定账号范围。',
  inputSchema: { type: 'object', properties: {}, required: [] },
};
module.exports.createTools = function createTools(pctx) {
  return {
    getDefs() { return [{ ...DEF }]; },
    getCatalog() { return [{ name: DEF.name, displayName: '邮箱账号列表', description: DEF.description, category: '邮件', categoryEmoji: '', defaultOn: false }]; },
    handles(n) { return n === DEF.name; },
    async execute(n) {
      if (n !== DEF.name) throw new Error(`未知工具: ${n}`);
      const accounts = await pctx.callService('accounts.list', {});
      return JSON.stringify(accounts, null, 2);
    },
  };
};
