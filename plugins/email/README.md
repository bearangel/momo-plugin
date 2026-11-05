# email 邮件插件（Momo Studio）

多邮箱收发助手：IMAP/SMTP 多账号 + 邮件面板（page 三栏）+ 7 个 agent 工具 + email-ops 技能 + 邮件助手预置 agent。设计 spec：moo-studio `docs/specs/2026-11-05-email-plugin-design.md`。

## 安装（开发流）

1. `cd vendor && npm install`（imapflow/nodemailer/mailparser，纯 JS 零 ABI）
2. Momo Studio → 设置 → 插件 → 开发目录装载 → 选本目录（`plugins/email`）
3. 资源库启用「邮件助手」agent（默认全局聊天模型）

## 使用

- **面板**：活动栏「邮件」页——添加账号（预设一键填充 + 测试连接）→ 收件箱/草稿/已发送
- **会话**：对邮件助手说「总结今天所有邮箱的新邮件」「给 xx@yy.com 回信说…」
- **发送门禁**：agent 只能起草；会话内展示全文并经你确认（或面板草稿箱手动点发送）才真发

## 验收记录（真邮箱）

| 场景 | 结果 | 日期 |
|---|---|---|
| QQ 邮箱添加（授权码）+ 测试连接 | ☐ | |
| 列表/读信/未读标记 | ☐ | |
| 会话摘要（多账号） | ☐ | |
| 起草 → 会话确认发送 → 面板 Sent 同步 | ☐ | |
| 附件：读邮件附件存工作区 / 发送带工作区附件 | ☐ | |

真机验收清单待执行（App 空闲 + 真邮箱授权码）
