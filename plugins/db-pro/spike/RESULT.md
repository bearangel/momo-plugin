# Spike #0 结论（Runtime 阶梯）

日期：2026-11-17

| 级别 | Runtime | legacy provider | dm 真握手 | 结论 |
|---|---|---|---|---|
| L1（首选） | ELECTRON_RUN_AS_NODE + `--openssl-legacy-provider` | ❌ `bad option: --openssl-legacy-provider`（Electron 44 内嵌 Node 不带该开关；NODE_OPTIONS 亦被拒：`not allowed in NODE_OPTIONS`） | 未达 | **不命中** |
| L2（回退 A） | 系统 node（24.14.1）+ `--openssl-legacy-provider` | ✅ `{"md4":true,"desEde3Cbc":true}` | ✅ `SELECT 1 FROM DUAL` 成功（对照组：不带 flag → `[20017] 获取连接请求等待超时`，证实 flag 硬需求） | **命中** |
| L3（回退 B） | vendor node 二进制 | — | — | 分发兜底（用户机无系统 node 时）；实施推迟到打包分发阶段 |

**最终阶梯命中：L2**——Task 13 `spawnLadderArgs` 实现：`command = 'node'`（PATH 探测）+ `args = ['--openssl-legacy-provider', engineEntry]`。service 自管 spawn（非 MCP client），env 无白名单限制。打包分发时（zip）追加 L3 vendor node。

## 附注

### dm 容器
- 镜像：达梦官方 docker tar 直链导入 `dm8_single:dm8_20241022_rev244896_x86_rh6_64`（x86_64，OrbStack Rosetta 运行正常）
  - Docker Hub 全线不可达（auth.docker.io EOF）；daocloud/1ms.run 白名单无 chillzhuang/dm；xuanyuan 免费节点限流
  - 下载断点续传三次完成（806MB，~1MB/s）
- SYSDBA 初始口令：`SYSDBA001`（SYSDBA/SYSDBA 不对）
- 端口：宿主 `127.0.0.1:15236`

### dmdb 驱动 API 形状（Task 8 实现输入——两次实测修正）
1. `createPool` 不接受分离的 `{host, port, user, password}` → `[20001] 无效的参数`
2. `PoolAttributes.connectString` 须为完整 URL 形态 `dm://user:pwd@host:port`（d.ts 注释写「host:port 或服务名」但运行时校验 `URL must start with 'dm://'`）
3. `Pool` 无 `execute` 方法——须 `pool.getConnection()` → `conn.execute()` → `conn.close()`（oracledb 同构但池面不同）
4. 口令/用户名特殊字符经 `encodeURIComponent` 编入 URL 可行

### oracle
- gvenzl/oracle-free 不在 daocloud 白名单；container-registry.oracle.com（Oracle 自家 registry）可达（HTTP 401 健康态），`database/free` 镜像拉取进行中——Task 17 前就位即可，不阻塞 Task 1-16。
