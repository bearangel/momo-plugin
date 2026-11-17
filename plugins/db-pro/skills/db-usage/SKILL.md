---
name: db-usage
description: 使用 db-pro 插件查询数据库的正确姿势：先探索结构再只读查询；写操作走人工批准两段式
---

# db-pro 数据库查询指引

## 工具面

- 探索：`list_connections` → `list_schemas` → `list_tables` / `list_views` → `describe_table` / `list_columns` / `get_ddl`
- 查询：`query`（只读：SELECT/SHOW/DESCRIBE/EXPLAIN/WITH-SELECT；禁多语句与 FOR UPDATE）
- 计划：`explain_query`
- 写（两段式）：`write` 创建请求（不执行）→ 提醒用户在「人工请求」面板处理 → `write_status` 查结果

## 姿势

1. 先 `list_connections` 确认可用连接；未配置时引导用户到 设置 → 插件 → db-pro 配置连接串（槽位 conn1-6，URL 形如 `mysql://user:pass@host:3306/db`、`postgres://…`、`oracle://user:pass@host:1521/服务名`、`dm://user:pass@host:5236`）
2. 查询前先 `describe_table` / `list_columns` 了解结构，避免瞎猜列名
3. 大表必加 WHERE / LIMIT；`query` 默认行数上限 200、超时 30s（超限截断并提示总数）
4. 写操作：`write` 后必须告知用户需要批准；**批准前绝不声称"已完成"**；用户批准后用 `write_status` 取结果（同一请求只会执行一次）
5. 被只读校验拒绝时不要绕——改写 SQL（如去掉 FOR UPDATE）或改用 `write`

## 错误对照

- 引擎未就绪 / 已退出 → 稍等重试（自动重启中）
- 连接失败 → 引导检查连接串与网络（密码不回显）
- query 超时 → 缩小结果集（WHERE / 分页）
- 达梦握手加密失败 → 环境问题，引导用户查看插件日志
