# db-pro —— 数据库查询插件（momo-studio）

agent 可查询 MySQL / PostgreSQL / Oracle（12c+ thin）/ 达梦 DM8：**只读直查 + 写操作人工批准**（两段式，多连接池）。设计依据：momo-studio `docs/specs/2026-11-17-db-pro-plugin-design.md`。

## 安装（dev 流）

momo-studio → 设置 → 插件 → 开发目录安装 → 选本目录。依赖：本目录内 `npm install`（Node 24）。

## 配置（设置 → 插件 → db-pro）

- 槽位 `conn1`-`conn6`：URL（敏感，入 keytar）+ 可选名称。格式：
  `mysql://user:pass@host:3306/db` · `postgres://user:pass@host:5432/db` · `oracle://user:pass@host:1521/服务名`（Oracle 11g 不支持） · `dm://user:pass@host:5236`
- `default_connection` / `readonly_max_rows`（200）/ `query_timeout_ms`（30000）

## 架构速览

```
agent 工具 plugin:db-pro/*（薄壳）
  → callService → 主进程 service（引擎进程管理 + 写两段式 human-gate）
  → db-engine 子进程（node --openssl-legacy-provider；四纯 JS 驱动连接池 + 只读校验）
```

引擎子进程必须带 `--openssl-legacy-provider` 启动（达梦 dmdb 握手依赖 legacy cipher；Electron 内嵌 Node 不支持该开关，故走系统 node——见 `spike/RESULT.md`）。

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
