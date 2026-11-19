# db-pro —— 数据库查询插件（momo-studio）

agent 可查询 MySQL / PostgreSQL / Oracle（12c+ thin）/ 达梦 DM8：**只读直查 + 写操作人工批准**（两段式，多连接池）。设计依据：momo-studio `docs/specs/2026-11-17-db-pro-plugin-design.md`。

## 安装（dev 流）

momo-studio → 设置 → 插件 → 开发目录安装 → 选本目录。依赖：本目录内 `npm install`（Node 24）。

## 配置（插件「数据库」面板）

连接在插件自带面板管理（侧栏连接列表 + 右侧编辑）：名称、描述、连接 URL、逐连接权限。
**无「缺省连接」**：agent 每次操作必须显式指定 `connection`；名称与描述用于说明该库用途（`list_connections` 会带出描述）。
格式：`mysql://user:pass@host:3306/db` · `postgres://user:pass@host:5432/db` · `oracle://user:pass@host:1521/服务名`（Oracle 11g 不支持） · `dm://user:pass@host:5236`。
URL 明文只入 keytar，面板与工具均不回显密码。旧版设置页 `conn1`–`conn6` 配置在首次启动时自动迁移（保等效全权限，旧密钥清除）。

**权限位（8 位，配置态闸；人工批准照旧）**

| 权限位 | 覆盖 |
|---|---|
| `query` | SELECT / SHOW / DESC / EXPLAIN / WITH（含结构读） |
| `insert` / `update` / `delete` | DML 三项（MERGE 需三项齐） |
| `ddl_table` | CREATE / DROP / ALTER / TRUNCATE TABLE |
| `ddl_other` | VIEW / INDEX / SEQUENCE / TRIGGER |
| `procedure` | CREATE / DROP / ALTER PROCEDURE / FUNCTION / PACKAGE + CALL |
| `script` | 脚本执行通道 |

预设档：只读 `{query}` · 读写 `{query,insert,update,delete}` · 全权（8 位） · 自定义。
权限与人工批准双闸独立：缺位直接拒绝（配置态），位齐后写/脚本仍走人工批准（运行态）。

**设置页（仅插件级参数）**：`readonly_max_rows`（200）/ `query_timeout_ms`（30000）/ `script_timeout_ms`（600000）

## 架构速览

```
agent 工具 plugin:db-pro/*（薄壳）
  → callService → 主进程 service（引擎进程管理 + 写两段式 human-gate）
  → db-engine 子进程（node --openssl-legacy-provider；四纯 JS 驱动连接池 + 只读校验）
```

引擎子进程必须带 `--openssl-legacy-provider` 启动（达梦 dmdb 握手依赖 legacy cipher；Electron 内嵌 Node 不支持该开关，故走系统 node——见 `spike/RESULT.md`）。

## 已知边界（终审在案）

- **达梦连接 `query_timeout_ms` 不生效**：dmdb 无池级/语句级超时注入点——查询时长仅受 service 桥 30s 上限约束（超时后引擎侧查询可能仍在跑占用连接）。后续版本在 dm 驱动层做超时取消。
- **MySQL `LOAD_FILE()` 等服务端文件读取函数过只读校验**：读取范围受数据库账号 FILE 权限约束——连接凭据即信任边界，属接受的风险；不允许的账号自然被数据库拒绝。
- **引擎依赖系统 node**：无 node 的机器上插件不可用（日志可见 spawn ENOENT 退避重试）；vendor node 兜底在分发阶段引入（spike RESULT.md L3）。

## 脚本执行通道（script_execute）

- 支持一次提交多语句脚本（MySQL `DELIMITER`、PG 美元引用、Oracle/DM PL/SQL 块与 `/`）。
- 流程：`script_execute` → 用户在「人工请求」面板批准 → 后台执行 → `script_status` 轮询。
- `dryrun: true` 只做静态分析（语句清单/目标表/分类计数），不连库不审批。
- 幂等/留痕由脚本自身实现；工具只记录通用执行历史（`script_history`）。
- 限额：脚本 ≤ 2MB、语句 ≤ 10000、整脚本超时缺省 600s（`script_timeout_ms`）。
- 不支持：`GRANT`/`REVOKE`（DBA 域）、SQL*Plus 控制流指令（`EXIT`/`WHENEVER`/`@file`）、psql 元命令。

## 测试

```bash
# 单测（Node 24）
npx vitest run tests/db-pro/
# 四库集成（OrbStack docker；oracle 镜像拉取见下）
docker compose -f tests/docker/docker-compose.yml up -d mysql pg dm
DBPRO_INTEGRATION=1 DBPRO_MYSQL=… DBPRO_PG=… DBPRO_DM=… npx vitest run tests/db-pro/integration.test.mjs
```

- 达梦镜像：Docker Hub 常不可达——用官方 tar 直链导入（`spike/RESULT.md` 附注有直链与口令 SYSDBA001）
- Oracle 镜像：`container-registry.oracle.com/database/free`（Oracle 自家 registry，不走 Docker Hub）

## 打包分发

```bash
cd plugins/db-pro && npm install --omit=dev
cd .. && zip -r db-pro-$(node -p "require('./db-pro/package.json').version").zip db-pro -x 'db-pro/spike/*'
```
（zip 内含 node_modules——四驱动全纯 JS，无平台 ABI 问题。）

## 许可备注

- 插件代码：随 momo-plugin 仓双授权（AGPL-3.0 + 商业授权）
- `dmdb` npm 包为达梦官方闭源许可（Proprietary）——仅作为依赖分发，见其 npm 页
