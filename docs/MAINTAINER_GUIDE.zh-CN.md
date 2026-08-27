# Codex Mantle 维护者指南

本文面向后续维护、跨平台接手和公开发布。仓库根目录的 `package.json` 固定了 Node.js 与 pnpm 的最低版本，锁文件是依赖安装的唯一依据。

## 支持基线

| 平台 | 最低工具 | 说明 |
| --- | --- | --- |
| Windows | Node.js 22、PowerShell 7、Git、pnpm 11 | 安装器和 Windows 验收脚本使用 PowerShell |
| Linux | Node.js 22、Git、pnpm 11 | 核心包与 CLI 可在无桌面环境检查 |
| macOS | Node.js 22、Git、pnpm 11 | 使用 POSIX 路径，不依赖盘符 |

优先使用仓库声明的 `pnpm@11.19.0`。如果 Corepack 因缓存位于不同磁盘或权限策略无法启用 pnpm，可以用一次性方式运行同一版本，不需要修改全局 Node 环境：

```powershell
npm exec --yes --package=pnpm@11.19.0 -- pnpm install --frozen-lockfile
npm exec --yes --package=pnpm@11.19.0 -- pnpm check
```

## 日常工作流

```text
修改 → format/check → lint/typecheck → test → build → repository:scan
```

常用命令：

```powershell
pnpm check
pnpm test:coverage
pnpm repository:scan
pnpm license:inventory
```

`pnpm check` 已包含版本一致性、格式、Lint、TypeScript、测试、构建和仓库启发式扫描。只改文档时仍应运行 `git diff --check` 和 `pnpm repository:scan`，防止把本机路径或凭据示例带入公开仓库。

## 工程边界

- `packages/core`：快照、路径边界、配置事务等与平台无关的核心能力。
- `packages/codex-adapter`：Codex CLI 能力探测、兼容性和 schema 适配。
- `packages/plugin-sdk`：插件清单契约与验证，不执行第三方代码。
- `packages/server`：仅回环监听的本地 API 和仪表盘服务。
- `apps/cli`：命令行入口与用户可见的错误处理。
- `apps/web`：本地状态仪表盘前端。
- `scripts/`：版本、发布、许可清单、仓库扫描和 Windows 安装支持。

新增功能应尽量落在正确的包内，避免 CLI 直接复制核心事务逻辑。跨平台代码使用 Node 的路径 API 和环境变量；不要写死用户目录、盘符、代理端口或本机服务地址。

## 变更与发布清单

1. 先更新相关测试和中文文档，再修改实现。
2. 运行 `pnpm check`，记录失败项与平台信息。
3. 涉及版本时同步检查各包版本、CHANGELOG、许可证清单和发布证明材料。
4. 只提交源码、测试、文档和可复现脚本；`dist/`、coverage、运行状态和本机 schema 不提交。
5. 发布前确认扫描未发现密钥、个人路径、工作区内容或供应商凭据。

本指南不替代[威胁模型](THREAT_MODEL.md)、[Windows 安装说明](WINDOWS.md)或[贡献指南](../CONTRIBUTING.md)。\n
