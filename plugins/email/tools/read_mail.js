// read_mail：读单封邮件（agent 视图）：纯文本正文（>30K 字符截断）+ 图片计数 + 附件清单。
// HTML 原文与内嵌 base64 图片不下发——防图多邮件撑爆 agent 上下文（2026-11-11）。
// 图片/排版详情让用户在邮件面板查看；mailparser 对 html-only 邮件自动生成 text，正文不丢。
'use strict';
const AGENT_TEXT_MAX = 30000;
// 大邮件异步预热轮询：service 对 >20MB 未归档邮件立即返回 deferred 并后台转入本地库，
// 工具在此预算内轮询重读直至命中归档快路径。超时不 throw——返回结构化状态让 LLM 告知用户稍后重试。
const WARMUP_POLL_INTERVAL_MS = 3000;
const WARMUP_POLL_BUDGET_MS = 60000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function agentView(mail) {
  const text = String(mail.text || '');
  const cut = text.length > AGENT_TEXT_MAX;
  return {
    uid: mail.uid, subject: mail.subject, from: mail.from, to: mail.to, date: mail.date, seen: mail.seen,
    text: cut ? text.slice(0, AGENT_TEXT_MAX) + '\n…（正文超长已截断，完整内容请让用户在邮件面板查看）' : text,
    textChars: typeof mail.textChars === 'number' ? mail.textChars : text.length,
    textTruncated: cut || mail.truncated === true,
    htmlChars: typeof mail.htmlChars === 'number' ? mail.htmlChars : 0,
    imageCount: typeof mail.imageCount === 'number' ? mail.imageCount : 0,
    attachments: Array.isArray(mail.attachments) ? mail.attachments : [],
  };
}

const DEF = {
  name: 'read_mail',
  description: '读取单封邮件内容（agent 视图）：正文纯文本（>30K 字符截断）+ imageCount 图片计数（HTML 原文与内嵌图片不返回，防上下文溢出）+ 附件清单（partId/文件名/大小）。附件本体用 save_attachment 保存到工作区；图片/排版详情请让用户在邮件面板查看。超 100MB 的邮件会被拒收。>20MB 的大邮件会自动后台转入本地库并最多等待 60s——超时返回转入中状态，稍后重试本工具即可秒读。',
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
      // patient + 30s 桥提示：终读（归档快路径解析大邮件）不受默认 8s/10s 预算掐；
      // 旧宿主（无 timeoutMs 支持）多余参数被忽略，行为退回默认预算，可接受。
      const fetch = () => pctx.callService('mails.get',
        { accountId: args.accountId, folder: args.folder, uid: args.uid, patient: true, warmup: true },
        { timeoutMs: 30000 });
      let mail = await fetch();
      const deadline = Date.now() + WARMUP_POLL_BUDGET_MS;
      while (mail && mail.deferred === true && Date.now() < deadline) {
        await sleep(WARMUP_POLL_INTERVAL_MS);
        mail = await fetch();
      }
      if (mail && mail.deferred === true) {
        const mb = ((mail.sizeBytes || 0) / 1048576).toFixed(0);
        return JSON.stringify({
          deferred: true, timedOut: true, uid: args.uid,
          message: `邮件（约 ${mb}MB）仍在后台转入本地库，预计还需 ${mail.estimateSec ?? '?'} 秒——请告知用户稍后再次调用 read_mail，届时将从本地库秒读`,
        }, null, 2);
      }
      return JSON.stringify(agentView(mail), null, 2);
    },
  };
};
