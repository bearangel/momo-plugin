# momo-plugin

Momo Studio 插件集中研发仓库。宿主应用 [momo-studio](../momo-studio) 的插件本体在此研发；插件系统（安装 / 启停 / hooks / 面板协议）由宿主提供，本仓只放插件。

设计依据：momo-studio 仓库 `docs/specs/2026-11-03-momo-plugin-repo-design.md`。

## 结构

```
plugins/<插件id>/     # 每个插件一个目录（momo-plugin.json 所在根）
tests/               # 跨仓测试（依赖 sibling 宿主，见下）
```

当前插件：

- `codegraph`（代码图谱，v2.0.1）
- `office-pro`（office 文档生成代码工坊：run_js 沙箱执行 + office-authoring 方法论 + 文档工程师预置；vendor 需先跑 `plugins/office-pro/scripts/build.sh` 构建）

office-pro 说明：其 `run-js` / `generation-smoke` 测试依赖宿主的 `execSandboxed` 设施（已合入 momo-studio main，commit a9c32744）——宿主 checkout 在位即真跑全绿。

## 开发工作流

momo-studio 设置 → 插件 → 开发目录安装，指向本仓的插件目录（如
`/Users/stbearangel/dev/AiProject/momo-plugin/plugins/codegraph`）。dev 安装不拷贝、
直读源码：改码后在宿主里执行「重载插件」即生效。发布走宿主的 momo-hub 发布链
（dev 源版本回写会直接改本仓 manifest 的 version 字段）。

## 本机产物（不入库）

`plugins/codegraph/engine/`（解包引擎，~283MB）与 `plugins/codegraph/vendor/`
（平台 tarball，~56MB）已 gitignore。新机器获取方式（二选一）：

- 从原环境拷贝 `engine/` 与 `vendor/` 两个目录；
- 经 momo-studio 的 momo-hub 发布链安装插件包（vendor tarball 内含引擎，安装
  时校验 sha256 + probe 可执行性）。

注意：插件运行时**不做引擎下载**（`mcp/mcp.json` 显式设 `CODEGRAPH_NO_DOWNLOAD=1`）。
引擎缺失时依赖引擎的测试（harness / 探针 / boot-chain）skip，其余测试照常真跑。

## 测试

```bash
nvm use 24                       # 宿主 native 依赖（better-sqlite3）ABI 一致性
npx pnpm@9.0.0 install           # 装 vitest
npx pnpm@9.0.0 test              # 引擎在位则真跑；缺失则 skip
```

前提与耦合面：

- 需要 sibling 目录有 momo-studio checkout 且已 `pnpm install`（测试经动态
  import 引用宿主内部模块 `db` / `host-manager` / `installer` 等，其 bare 依赖
  经宿主自身 node_modules 解析）
- 宿主位置默认按 sibling 候选探测（`../momo-studio`、`../moo-studio`——取首个
  在位者），可用环境变量 `MOMO_STUDIO_ROOT` 显式指定（显式设置即独占，设错
  → 测试 skip 而非静默回退）
- **耦合警告**：宿主重构改动上述内部模块 API 时，本仓测试需同步修改——这是
  有意保留的耦合面（spec D2），README 即契约
