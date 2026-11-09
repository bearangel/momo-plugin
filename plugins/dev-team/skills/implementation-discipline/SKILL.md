---
name: implementation-discipline
description: 实现纪律——先读后改节奏、最小 diff 判例、验证命令序与提交规范
---

# implementation-discipline

## 先读后改

- 改任何文件前：读目标文件 + 同目录至少一个邻近文件（对齐风格 / 既有模式）
- 找相似实现当参照物；仓库已有工具函数不重复造

## 最小 diff

- 只修目标问题；「顺手」重构 / 改格式 / 补功能一律不做
- 删代码必须说明依据；行为变更在汇报中逐条列出

## 验证命令序

- 目标仓有测试 → 跑相邻测试；无测试 → 类型检查；再无 → 构建 / 语法检查
- 结果如实汇报，绿了才算数

## 提交规范

- conventional commits：feat / fix / chore / docs / test / refactor（+ scope）
- 用户（或队长）明确确认后才 git_add + git_commit

## 不中间提交

- 团队任务中变更留工作区，由队长验收后统一收口提交；除非用户 / 队长明确要求单独提交
