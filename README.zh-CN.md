# Codex Mantle

Codex Mantle 是一个面向 OpenAI Codex 的本地优先、可恢复控制层。它用于检查 Codex 环境、
把协作配置纳入版本管理、预览策略变更、创建逐字节快照，并通过轻量本地网页统一查看状态。

> 当前为 Alpha。默认只读；受管理配置变更（`profile apply` 与 `snapshot restore`）必须先形成计划
> 或取得显式批准，完成备份并验证结果。

[English](README.md)

## 为什么做 Mantle

Codex 更新很快，真实工作区又会逐渐积累全局指令、项目规则、skills、plugins 和机器相关配置。
Mantle 不 fork Codex，也不绑定私有协议，而是在外层提供稳定安全边界：

- 用能力探测与已测试版本系列白名单代替乐观版本猜测；
- 写配置前生成计划并锁定原文件哈希；
- 用 SHA-256 清单保存逐字节快照，恢复必须显式批准；
- 用 Git 可审查的 policy pack 管理协作规则；
- 本地网页和 API 只监听回环地址；
- 用带版本的适配器与插件契约承接后续能力。

可以渐进使用：`doctor` 和仪表盘不会修改 Codex 文件；应用策略是单独、可审计的操作。计划、
schema 和安装产物只写入显式指定的新建、空目录或 Mantle 自有位置，它们不属于受快照保护的配置事务。

## v0.1 能力

- `codex-mantle doctor`：检查 Node、Git、PowerShell、GitHub CLI、Codex 及本机能力。
- `codex-mantle compatibility probe`：只读识别 Codex CLI，并报告能够证明的能力契约。
- `codex-mantle compatibility schema --output <空目录>`：显式生成当前 CLI 的版本专属
  app-server schema，供本地检查。
- `codex-mantle snapshot create|list|inspect|restore`：为指定文件建立逐字节快照并恢复。
- `codex-mantle profile plan|apply`：解析策略包、展示准确目标与哈希、校验陈旧状态、先快照再
  进行可验证的尽力事务。
- `codex-mantle plugin validate`：只验证扩展清单，不执行第三方代码。
- `codex-mantle serve`：启动仅本机可访问的状态仪表盘。

模型路由不进入 v0.1。Mantle 为未来任务分发器预留扩展边界，但首版不要求 API Key，也不把
工作区内容发送给任何模型服务商。

## 从源码开始

需要 Node.js 22+、pnpm 11.x（已验证 11.19.0）、Git；Windows 需要 PowerShell 7。

```powershell
git clone https://github.com/roy-reed/codex-mantle.git
Set-Location codex-mantle
pnpm install --frozen-lockfile
pnpm check
pnpm --filter @codex-mantle/cli start -- doctor
pnpm --filter @codex-mantle/cli start -- serve --open
```

Windows 可生成当前用户范围的启动器：

```powershell
pwsh -File .\scripts\Install-CodexMantle.ps1
& "$env:LOCALAPPDATA\Programs\CodexMantle\bin\codex-mantle.ps1" doctor
```

安装器不会修改 Codex 配置。升级和卸载行为见 [Windows 安装](docs/WINDOWS.md)。

## 安全不变量

1. 只有同时识别所需能力契约与已测试 Codex 版本系列时才允许受控写入，否则退回只读模式。
2. 计划记录每个目标写入前应有的哈希，文件变化后旧计划自动失效。
3. 应用前必须创建并核验逐字节快照。
4. 恢复必须提供批准值，且默认拒绝符号链接、目录联接和目标漂移。

状态默认保存在仓库之外：Windows 使用 `%LOCALAPPDATA%\CodexMantle`；Linux/macOS 使用
`$XDG_STATE_HOME/codex-mantle` 或 `~/.local/state/codex-mantle`。测试或便携场景可设置
`CODEX_MANTLE_HOME`。

启用写入自动化前，请先阅读[威胁模型](docs/THREAT_MODEL.md)。

## 架构原则

核心事务层不依赖 app-server。app-server 的 schema 随已安装 Codex 版本生成，协议接入始终隔离在
适配器后面。插件 v0.1 只做清单发现和校验，不加载第三方代码。

更多内容见[架构](docs/ARCHITECTURE.md)、[兼容性](docs/COMPATIBILITY.md)和
[路线图](docs/ROADMAP.md)。

## 当前边界

v0.1 是可长期演进的薄层，不是另一个完整 Codex 客户端。它不代理模型流量、不保存供应商密钥、
不静默合并任意 TOML/Markdown、不执行不可信插件、不向局域网开放 API，也不提交本机生成的私有
schema。这样既能解决真实问题，又不会让每次交互都背负额外流程和 token 成本。

项目方向参考了 Codey、Codex++ 与 OpenCodex 的公开体验，但采用 clean-room 独立实现，不复制三者
源码。Codex Mantle 是社区独立项目，与 OpenAI 无隶属或背书关系。

参与开发请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。许可证为
Apache-2.0。
