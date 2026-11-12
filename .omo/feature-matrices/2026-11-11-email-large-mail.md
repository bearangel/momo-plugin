# 消费面矩阵：email 插件大邮件支持 + 已读标记 + agent 视图瘦身 + 附件临时文件中转（2026-11-11）

范围：momo-plugin 仓 plugins/email。宿主（momo-studio）零改动。

## W1 机械枚举结果（三锚 grep：attachments.get / mails.get / 限额常量 + 展示面）

| # | 消费点 | 分类 | 改动 |
|---|---|---|---|
| 1 | tools/read_mail.js（mails.get agent 通路） | 数据通路 | 改：agent 视图转换 + description |
| 2 | tools/save_attachment.js（attachments.get 唯一消费方） | 数据通路 | 改：tmpPath 中转拷贝流程 |
| 3 | panel/index.html mails.get（唯一面板消费点） | 数据通路+展示面 | 改：patient:true + markSeenLocal 即时去蓝点 |
| 4 | service/index.js 两路由装配 | 装配链 | 改：patient 透传 + attachments.get 中转包装 + 启动清扫 tmp |
| 5 | mailbox.js READ_SOURCE_MAX/ATTACH_MAX 守门 + 在线读信路径 | 生效层 | 改：100MB / 载体对齐 / fetchOne 单封 / markSeen best-effort + 缓存回写 |
| 6 | archive.js ARCHIVE_MAX_BYTES | 生效层 | 改：25MB→100MB |
| 7 | service adapter（imapAdapterFor 契约） | 装配链 | 改：+fetchEnvelope +markSeen |
| 8 | tests/email/*（mock conn / FakeImapFlow / 契约断言） | 测试 | 改：随契约更新 + 新增回归 |
| 9 | skills/email-ops/SKILL.md 限额表 + 两工具 description | 文档面 | 改：2MB/10MB/25MB 语义更新 |
| 10 | email-assistant.yaml / plugins/email/README.md | 文档面 | 不改（grep 证实无限额文案） |
| 11 | 宿主 panel 通道 / requestPluginCallService 桥 | 外部约束 | 不改：面板通道宿主侧无超时（仅面板 JS 30s→60s 自管）；agent 桥 10s 为既定约束，patient 分层绕开 |

## 四类展示面 checklist

- 资源目录页：不适用（插件无资源注册面）
- 选择器候选列表：不适用
- 命令引用入口：不适用（无 / 命令面）
- 各编辑器：不适用（插件无定义编辑器）

## 生命周期列

- 新建（新增 tmp-relay 通道）：attachments.get 新契约 + 启动清扫 + 工具 finally 删除
- 存量（旧 base64 契约调用方）：唯一调用方 save_attachment 同仓同步改造，无兼容层（插件 0.x 内部契约）
- builtin 只读：不适用

## W3 反查差集

W1 清单与矩阵行一一对应，差集为空。

## W4 门禁

1. / 命令类入口：不适用（无）
2. 编辑器候选：不适用（无）
3. 资源目录页签：不适用（无）
4. 存量兼容路径：已写明（行 12——同仓唯一消费方同步改，无跨仓调用方；grep 证实）
5. builtin 只读通道：不适用
6. 状态翻转类：本次非启停/可见性翻转（限额数值变更），seen 状态翻转的消费点=信封缓存读取（envelopesPeek/list 共用 cache）+ 面板蓝点 renderList + folders.unseen 计数——三处均已裁定（缓存回写 / markSeenLocal / 本地减 1）
7. 生效层（mailbox/archive/adapter）与可见层（SKILL.md/工具 description/面板蓝点）两层分别有裁定：是
8. 验收锚点：存量场景=既有测试全量更新跑绿；新场景=100MB 边界/markSeen 两路/中转契约新增用例

## W5 验收回填

- 全量 `vitest run tests/email --pool=forks`（2026-11-11）：**198 passed / 5 skipped，15/16 文件绿**。
- 唯一失败 `dev-install.test.ts` 为 beforeAll 装载宿主模块链 240s 超时——**干净树（stash 后）复跑同样超时**，先于本次改动存在的环境性失败，与插件改动无关。
- 新增回归证据：`service-mailbox`（3MB 放行 / 101MB 拒收 / fetchOne 单封无 search / markSeen 在线+归档两路 / markSeen 失败不阻断且不回写 / seen=true 不重复标记 / textChars/htmlChars/imageCount / 归档 raw >100MB 拒收 / patient 参数 / deferred 形状与秒回 / 未传 warmup 同步 / 归档命中优先 / 预热去重 / 失败退避）；`service-index`（messageFlagsAdd(\Seen) 回归锁 / patient+warmup 透传 / attachments.get tmpPath 契约无 base64 面 / partId 不存在中文报错 / tmp-relay 启动清扫过期保留新鲜）；`tools-readonly`（agent 视图无 html 无 base64、30K 截断、imageCount 透出 / 短文不误标 / deferred 轮询收敛 + 60s 超时结构化状态）；`tools-write`（中转全链+即删 / >10MB 放行 / tmpPath 缺失报错 / 门禁失败也清理 / wsFs 缺注入报错）；`archive`（100MB 边界）；`panel-static`（patient / markSeenLocal 锚点）。

## 附录：立项 A+B（2026-11-11 同日第二批）

用户追问「agent 读邮件是否也该走文件」引出的立项。裁定：读邮件回包载荷已瘦身（≤130KB JSON），**不需要文件形态**；需要的是把同步等待异步化。

- **A（宿主 momo-studio）**：`requestPluginCallService` 增 `opts.timeoutMs`（钳制 [1s,60s]，默认 10s 不变）；`PluginToolCtx.callService` 类型+装配透传。消费面：唯一调用方 plugin-tools.ts；旧调用零感知。契约测试 3 个新增全绿；双 workspace typecheck 绿。lifecycle-p3.test.ts 因 better-sqlite3 ABI 环境问题（Electron 149 vs Node 137，AGENTS.md 已知陷阱）无法在本机验证——失败在 native 加载，与改动无关。
- **B（插件 momo-plugin）**：mailbox `triggerWarmup`（去重 + 2min 失败退避 + 10min 预算后台拉源落归档）；`readImpl` warmup opt-in（>20MB 未归档 → 秒回 deferred + estimateSec）；`mails.get` 透传；`read_mail` 轮询收敛（3s 间隔 / 60s 预算 / timeoutMs 30s + patient；超时返回结构化「转入中」不 throw）。面板零改动（不传 warmup，语义不变）。
- 回填：tests/email 全量 **201 passed** / 5 skipped / 15 文件绿（唯一失败 dev-install 为已定基线的宿主装载环境问题，干净树同败）。

## 附录二：App 级 e2e 验收（2026-11-11 深夜，真实 profile 已授权）

- 报告：moo-studio `.omo/qa-reports/2026-11-11-email-plugin-e2e/report.md`（pass 12/13，fail 1=P2 D1）
- **e2e 发现并当日修复的两个真实根因**（单测无法覆盖——需真实 IMAP 服务器）：
  1. adapter fetch 信封查询从不请求 FLAGS 字段 → seen 恒 false（列表全未读假象+刷新蓝点回归的真凶）。修复：fetchEnvelopes/fetchEnvelope 补 `flags:true`；单测锁 `fetch 信封请求必须含 FLAGS 字段`。
  2. imapflow `messageFlagsAdd` 失败静默返回 false → markSeenAndSync 误判成功并回写缓存。修复：adapter 判 `ok!==true` 抛错；单测锁「静默 false 不误标缓存 seen」。
- 验收中大链路全通过：24MB 邮件 read_mail（warmup 三次轮询+归档收敛）、18MB 附件 draft→人审→发送→送达→save_attachment（md5 一致）、tmp-relay 零残留、agent 视图无 html 面。
- 遗留缺陷：D1（P2 发送后已发送归位/删草稿超时）、D2（P3 服务商 STATUS 缓存）、D3（P3 25MB 上限按编码后体积的文案）。
