---
name: email-ops
description: 邮箱操作方法论——多账号经 plugin:email/* 工具集收发邮件的正确姿势与发送契约
---

# email-ops

## 工具速查

- `plugin:email/list_accounts` 已配置账号（脱敏；带健康态）
- `plugin:email/list_folders` 文件夹树（草稿/已发送归位探测）
- `plugin:email/list_mails` 信封分页（filter：since/unreadOnly/from/subject；每页 ≤50）
- `plugin:email/read_mail` 单封内容（agent 视图：纯文本正文 >30K 字符截断；imageCount 图片计数；HTML 原文/内嵌图片不下发；>100MB 拒收）。>20MB 大邮件自动后台转入本地库并最多等 60s，超时返回「转入中」→ 稍后重试即秒读
- `plugin:email/save_attachment` 附件存工作区（受整封邮件 ≤100MB 约束；路径为工作区相对路径）
- `plugin:email/draft_mail` 起草（不发送；附件=工作区相对路径数组，总量 ≤25MB）
- `plugin:email/send_draft` 发送已确认草稿（仅 draftId）

## 操作方法论

1. 先 `list_accounts` 定账号（多账号逐一处理，单账号失败不拖全局——按失败原因报告）
2. `list_mails` 用 filter 圈定范围（日期/未读/发件人/主题），忌全量 read_mail
3. 按需 `read_mail` 细读重点邮件；摘要按发件人/主题线索分组，未读与回复链优先，提取时限词（截止/回复期限）

## 起草规范

- 称谓得体；回复引用关键原文（简摘，不整段粘贴）；落款默认跟随账号显示名
- 附件给工作区相对路径；超限（单件受整封 ≤100MB 约束 / 发送总量 25MB）提前告知用户调整

## 发送契约（硬规则）

1. `draft_mail` 起草后，**必须在回复中完整展示**收件人/主题/正文/附件清单
2. 明确询问「确认发送？」，等待用户答复
3. 仅当用户明确同意（如「确认发送」「发吧」）才调用 `send_draft`
4. 禁止：未经确认调用 send_draft；谎称已发送——发送成功以 send_draft 返回 sent 为准，失败如实报告原因
5. 用户要求修改 → 重新 draft_mail（旧草稿会 24h 自动作废，或建议用户在面板放弃）

## 错误处置

| 症状 | 处置 |
|---|---|
| 认证失败（auth） | 提示用户到邮件面板检查授权码（可能过期/IMAP 未开启），勿重试轰炸 |
| 文件夹不存在 | 先 `list_folders` 拿准确路径（中文文件夹名常见） |
| 附件超限 | 明确报数值上限，建议用户改用小文件或网盘链接 |
| 邮件 >100MB | 整封读取被拒，让用户在邮箱客户端处理 |
| 图多邮件 | read_mail 只给纯文本+imageCount；图片内容请让用户在邮件面板查看 |
| 大邮件读取超时 | read_mail 已自动后台转入本地库（最长等 60s）；收到「转入中」→ 告知用户稍候片刻后再次调用 read_mail，从本地库秒读 |
| 超时 | 提示网络状况，缓存列表仍可用（降级） |
