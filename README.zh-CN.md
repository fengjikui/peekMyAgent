# peekMyAgent

peekMyAgent 是一个本地优先的 Agent 请求观察工作台，用来查看 Claude Code、OpenClaw 等 coding agent 在调用模型前真正发送出去的请求。

它可以帮助你理解 Agent 如何组织 system prompt、用户消息、工具定义、工具调用、工具结果、历史上下文、模型参数和原始 JSON。peekMyAgent 不是用来“破解隐藏提示词”的工具，而是面向你自己授权的本地 Agent 会话的可观测性工具。

## 一图看懂

![peekMyAgent dashboard feature tour](assets/demo/dashboard-overview-tour.gif)

<p>
  <strong>普通聊天上行上下文拆解</strong><br>
  查看一次普通聊天请求里真正发送给模型的 System、Tools、Messages 和 Response 切片。
</p>

<p>
  <img src="assets/demo/chat-upstream-context.gif" alt="普通聊天上行上下文拆解" width="960">
</p>

<p>
  <strong>工具调用闭环拆解</strong><br>
  从时间线里追踪一次基础 <code>tool_use</code> -> <code>tool_result</code> -> 最终回答的完整链路。
</p>

<p>
  <img src="assets/demo/tool-call-loop.gif" alt="工具调用闭环拆解" width="960">
</p>

更多静态标注图、普通聊天上行拆解、工具调用闭环和 README 录制脚本见：[图文使用说明](docs/visual-usage-guide.zh-CN.md)。

## 当前能力

- 打开本地 dashboard：`http://127.0.0.1:43110`。
- 通过 `pma claude ...` 启动 Claude Code 并捕获模型请求。
- 通过 `pma openclaw ...` 启动 OpenClaw 并捕获模型请求。
- 在时间线中查看用户输入、System 摘要、Tools、Tool calls、Tool results、Response、token 统计和 Raw JSON。
- 识别并展示 Claude Code 子 Agent 请求流。
- 在 Claude Code 内通过 `/peekmyagent` 打开 dashboard。
- 暂停、恢复、停止或清理当前捕获。
- 直接从 dashboard 向正在监听的 Agent 发送消息。

## 环境要求

- macOS、Windows 或 Linux。
- Node.js 24 或更新版本。peekMyAgent 当前使用 Node 内置的 `node:sqlite` 作为本地存储运行时。
- 已安装并可正常使用 Claude Code 或 OpenClaw。
- 模型供应商配置需要先在原 Agent 中可用。

如果 `claude` 本身不能运行，请先修好 Claude Code 配置：

```bash
claude --version
claude -p --output-format text "Reply OK"
```

## 从源码安装

```bash
git clone https://github.com/fengjikui/peekMyAgent.git
cd peekMyAgent
node scripts/install.mjs
```

Windows PowerShell 使用同样的命令：

```powershell
git clone https://github.com/fengjikui/peekMyAgent.git
cd peekMyAgent
node scripts/install.mjs
```

安装器会执行 `npm install`、用 `npm install -g .` 从当前源码安装 CLI，然后运行 `pma doctor`。安装后会同时提供 `pma` 和 `peekmyagent` 两个命令；下面示例优先使用更短的 `pma`。如果只想预览安装计划，不修改机器：

```bash
node scripts/install.mjs --dry-run
```

手动安装等价于：

```bash
npm install
npm install -g .
```

如果你是在开发 peekMyAgent 本身，明确希望使用工作区软链，也可以手动使用 `npm link`。

检查命令是否可用：

```bash
pma --help
pma doctor
peekmyagent --help
peekmyagent doctor
```

如果不想全局安装命令，也可以直接运行：

```bash
node bin/peekmyagent.mjs --help
```

## 快速开始：Claude Code

先打开 dashboard：

```bash
pma open
```

在你的项目目录中，通过 peekMyAgent 启动 Claude Code：

```bash
cd <your-project>
pma claude -c
```

之后正常使用 Claude Code，请求会出现在 dashboard 中。

Claude Code 捕获默认使用 `auto` 模式：如果检测到可配置的上游 base URL，就走代理精确捕获；如果没有，则自动使用 OTel raw-body 捕获，适合官方订阅 / OAuth 登录场景。高级用户可以用 `pma --proxy claude ...`、`pma --otel claude ...` 或 `pma --capture otel claude ...` 强制模式。

如果你明确希望 Claude Code 跳过权限确认，把 Claude Code 自己的参数放在 `claude` 后面：

```bash
pma claude -c --dangerously-skip-permissions
```

这个参数属于 Claude Code，不属于 peekMyAgent。它会绕过 Claude Code 的常规权限检查，只建议在你信任的仓库中使用。

## 快速开始：OpenClaw

```bash
pma open
cd <your-project>
pma openclaw chat
```

## 常用命令

```bash
pma open
pma open --print
pma doctor
pma compact
pma clear --all-sessions
pma uninstall --keep-data
pma uninstall --remove-data
```

`pma compact` 会压缩旧版存储，不删除会话。它会清理可由分块缓存重建的重复完整 raw request body，并默认执行 SQLite `VACUUM` 回收文件空间。执行时会短暂停止本地 dashboard daemon，之后可用 `pma open` 重新打开。

`pma uninstall --keep-data` 会卸载 `pma` / `peekmyagent` 命令、移除 peekMyAgent 安装的 helper，并停止 daemon，但保留本地捕获数据。

`pma uninstall --remove-data` 会卸载 CLI、移除 helper，并删除 peekMyAgent 拥有的本地状态数据。

如果你是从源码目录安装，也可以在该源码目录运行源码卸载脚本：

```bash
node scripts/uninstall.mjs --keep-data
node scripts/uninstall.mjs --remove-data
```

`uninstall --remove-data` 只删除 peekMyAgent 已知拥有的数据，例如 session store、viewer registry、IDE integration registry 和翻译缓存；只有当 state 目录变空时才会删除目录本身。它不会改写 Agent 供应商配置。

## 隐私与安全

peekMyAgent 默认本地运行，但捕获内容仍可能包含 system prompt、工具 schema、源码片段、文件路径、命令输出、模型参数和原始 provider request body。

- 第一次试用建议使用不敏感的项目。
- 不要分享包含私有代码、密钥或专有 prompt 的 dashboard 截图。
- 导出的 Trace 包会默认脱敏常见 token/API key pattern，但仍可能包含私有提示词、源码片段、文件路径或工具输出；分享前请先检查导出文件。
- 不要把本地 dashboard 暴露到公网。
- 输入敏感内容前可以先用 `/peekmyagent-pause` 暂停记录。
- 不再需要某段记录时，用 `/peekmyagent-clear` 清理本地 dashboard 记录。

## Windows 注意事项

- 推荐从 PowerShell 或 Git Bash 中运行。
- Claude Code 可以通过环境变量或 `.claude/settings.json` 配置上游模型；peekMyAgent 会尽量读取这些配置。
- 如果端口 `43110` 或 `43111` 被占用，先看清楚端口归属：

```powershell
pma doctor
```

如果确认是自己的 peekMyAgent daemon，再运行 `pma restart`；如果是其他程序占用，请手动停止那个程序或换用 `PEEKMYAGENT_DAEMON_PORT`。

项目维护者验证对应平台时可以运行：

```bash
npm run release:check:linux
npm run release:check:macos
npm run release:check:windows
```

在其他平台上只查看 gate 列表：

```bash
npm run release:check:linux:list
npm run release:check:macos:list
npm run release:check:windows:list
```

## 发布前自测

```bash
npm run release:check
```

这会运行跨平台核心 smoke gate，包括路径解析、doctor、源码安装、临时全局安装、维护/卸载、dashboard、Claude wrapper、发送消息、Trae CN 路由、持久化和请求树检查。

需要真实 Claude Code、OpenClaw、Codex、provider 或本机登录态的验证不放进默认 gate，维护者可参考 [手动集成 smoke 矩阵](docs/manual-integration-smoke-matrix.md)。

## 更多文档

- [用户指南](docs/user-guide.md)
- [图文使用说明](docs/visual-usage-guide.zh-CN.md)
- [当前架构](docs/architecture.md)
- [重构路线图](docs/refactoring-roadmap.md)
- [Roadmap / 待实现计划](docs/roadmap.md)
- [隐私与保留策略](docs/privacy-retention-strategy.md)
- [安全与性能审计纪要](docs/security-performance-audit.md)
- [手动集成 smoke 矩阵](docs/manual-integration-smoke-matrix.md)
- [Claude Code 当前会话控制](docs/claude-code-current-session-control.md)
- [OpenClaw profile watch](docs/openclaw-profile-watch.md)
