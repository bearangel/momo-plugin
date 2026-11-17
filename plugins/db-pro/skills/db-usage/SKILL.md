---
name: db-usage
description: 使用 db-pro 插件查询数据库的正确姿势（只读直查 + 写操作人工批准两段式）
---

# db-pro 数据库查询指引

核心规则：查询前先探索结构（list_connections → list_tables → describe_table）；
写操作必须 write → 用户批准 → write_status 两段式，批准前绝不声称已执行。
（骨架版本，Task 16 扩全。）
