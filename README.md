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
- `dev-team`（研发团队，v0.1.0）—— 8 个研发辅助 agent（只读组：探索/评审/架构顾问；执行组：实现/测试/调试；编排：研发队长分支路由与统一收口提交；交付：文档工程师）+ 9 册方法论 skills；设计 spec 见 momo-studio `docs/specs/2026-11-09-dev-team-plugin-design.md`

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

## 行尾纪律（LF）

本仓 `.gitattributes` 钉死 `* text=auto eol=lf`。原因：宿主 `parseSkillMd` 按 `\n`
切分 frontmatter，Windows 机器 `core.autocrlf=true` 检出成 CRLF 会让 SKILL.md
解析失败（症状：插件装上但技能列表空）。二进制后缀显式标 `binary` 不做转换。

Windows 上已有 clone 若发现工作区是 CRLF，执行一次：

```bash
git rm --cached -r . && git reset --hard
```

## 打包离线分发包（Windows）

```powershell
pwsh -File scripts/build-plugin-packages.ps1
```

产物落 `dist-release/`（gitignored）：每个插件一个「解压即可 dev 装载」的目录 +
同名 zip + `SHA256SUMS.txt`。脚本做四件事：

1. 复制 `plugins/*` 为插件根；
2. **codegraph 生成 Windows 变体**：manifest 只声明 `vendor/codegraph-win32-x64.tar.gz`
   （sha256 自动回填）——宿主安装器会把声明的**全部** vendor 归档解压进同一个
   `engine/`，多平台归档共存必坏；`mcp.json` **保持仓库原样**（`${engineNode}` /
   `${engineBin}`），由宿主 `template-expand` 按平台解析（win32 → `engine/node.exe`
   + `engine/bin/codegraph.cmd`）。切勿在打包时把 command 改写成
   `${pluginRoot}/engine/node.exe`：`mcp-sync` 的 stdio 命令校验只放行「整串占位符」
   或合法 npm 包名，带前缀路径会被判非法 → MCP 不注册（表现：插件装了但看不到
   MCP、也不能给 agent 授权）；
3. office-pro 补中文字体（取自宿主 checkout 的 `electron/resources/fonts/`）；
4. 插件自有文本（md/json/yaml/js/html/css）行尾归一 **LF**，跳过 `engine/` 与
   `node_modules/`。

前置：`plugins/codegraph/engine/` 与 `vendor/codegraph-win32-x64.tar.gz` 需先就位
（见上节「本机产物」）。**zip 里刻意不带已解压的 `engine/`**——宿主 zip 安装会在
`finalizePluginInstall` 里从 vendor 归档解压出 `engine/`，两样都带会把解压总量翻倍
（253MB 引擎 + 53MB 归档 = 303MB，直接撞 200MB 解压上限）。若要「开发目录装载」，
先自己解压归档：

```bash
tar -xzf vendor/codegraph-win32-x64.tar.gz -C engine
```

体积/条目预算（宿主 `installer.ts` 守卫）：解压总量 ≤ 200MB、zip 条目 ≤ 20000
（后者由 5000 上调，原因就是 office-pro 这类 vendor 内置 224 个 npm 包、7000+ 文件的
真实插件会被误杀）。
