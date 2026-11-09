# 消费面矩阵 — dev-team 插件（2026-11-09）

依据：momo-feature-scope-rules W1–W5；设计文档：moo-studio `docs/specs/2026-11-09-dev-team-plugin-design.md` §8。

性质：agents-only 新插件（无自定义工具 / 无 service / 无状态翻转 / 无新增资源类型）。W1 三锚 grep：宿主侧零改动点；插件侧全部为新增文件。W3 反查差集为空。

| 消费面 | 新建（dev-team 8 agent） | 存量（email/codegraph/office-pro） | builtin（general-assistant） |
|---|---|---|---|
| 资源库 agent 页签 | 原生（agent_definitions source='plugin'） | 不改：slug 互异无碰撞 | 不改 |
| 加成员候选 AddAgentDialog | 原生，source 徽标「插件」 | 不改 | 不改 |
| @ 提及菜单 | 原生（同一 agent 列表源） | 不改 | 不改 |
| 快速会话默认 agent 选择器 | 原生，用户可选 | 不改 | 不改（默认位不变） |
| / 命令入口 | N/A（宿主固定注册表，不可插件化——设计如此） | N/A | N/A |
| 定义编辑器 DefinitionEditor | 插件定义只读（既有语义） | 不改 | 不改 |
| 成员编辑 MemberEditDialog 工具面 | 原生显示 defaultTools，deltas 增删（既有模式） | 不改 | 不改 |
| 团队派发 buildSpawnOpts | 原生（capability merge） | 不改 | 不改 |

W4 门禁八问：全「是」（逐项见设计文档 §8）。

W5 验收回填（待验证，对应设计文档 §10）：

- [ ] 安装启用 + 资源库 8 agent 可见（§10-1/2）
- [ ] 团队链路：lead 派发 → 成员执行 → 验收 → 统一提交，无中间提交（§10-2）
- [ ] builtin 锚点：general-assistant 不受影响（§10-3）
- [ ] 存量锚点：email-assistant 候选与工具面正常（§10-4）
- [ ] 权限面显示与 §5 矩阵一致（§10-5）
