# peekMyAgent

peekMyAgent 是一个本地优先的 Agent 请求观察工作台，用来查看 Claude Code、Codex、OpenCode、OpenClaw 等 coding agent 的执行链路和模型请求。

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
- 在受支持的 macOS 版本上继续使用 Codex Desktop 原生界面并进行 Responses 精确捕获，也可显式退回零复制 rollout 观察，或通过精确代理启动 Codex CLI。
- 通过 `pma opencode ...` 启动 OpenCode，只精确捕获当前 CLI/TUI 进程，并在退出后自动撤销代理覆盖。
- 通过 `pma openclaw ...` 启动 OpenClaw 并捕获模型请求。
- 在左侧切换当前观察的 Agent，让 Codex、Claude Code、OpenCode、OpenClaw 和导入 Trace 分开显示。
- 在时间线中查看用户输入、System 摘要、Tools、Tool calls、Tool results、Response、token 统计和 Raw JSON。
- 识别并展示 Claude Code 子 Agent 请求流。
- 在 Claude Code 内通过 `/peekmyagent` 打开 dashboard。
- 暂停、恢复、停止或清理当前捕获。
- 直接从 dashboard 向正在监听的 Agent 发送消息。

## 环境要求

- macOS、Windows 或 Linux。
- Node.js 24 或更新版本。peekMyAgent 当前使用 Node 内置的 `node:sqlite` 作为本地存储运行时。
- 已安装并可正常使用你准备观察的 Claude Code、Codex、OpenCode 或 OpenClaw。
- 模型供应商配置需要先在原 Agent 中可用。

如果 `claude` 本身不能运行，请先修好 Claude Code 配置：

```bash
claude --version
claude -p --output-format text "Reply OK"
```

## 安装

通过 npm 全局安装公开 Alpha：

```bash
npm install --global peekmyagent@next
```

安装后会同时提供 `pma` 和 `peekmyagent` 两个命令；本文优先使用更短的 `pma`。安装完成后检查：

```bash
pma doctor
pma --help
```

以后重复执行同一条 npm 命令即可更新到最新 Alpha。首个稳定版本发布后，使用 `npm install --global peekmyagent` 安装和更新稳定通道。

如果本机 npm 使用的镜像尚未同步新版本，可以明确使用 npm 官方 registry：

```bash
npm install --global peekmyagent@next --registry=https://registry.npmjs.org/
```

### 从源码安装

贡献者可以克隆仓库并运行源码安装器：

```bash
git clone https://github.com/fengjikui/peekMyAgent.git
cd peekMyAgent
node scripts/install.mjs
```

源码安装器等价于：

```bash
npm install
npm install -g .
pma doctor
```

如果只想预览源码安装计划，不修改机器：

```bash
node scripts/install.mjs --dry-run
```

开发时也可以使用 `npm link`，或者不全局安装，直接运行：

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

## 快速开始：Codex

在希望观察的项目目录中，让 Codex 通过当前进程专属的精确代理启动：

```bash
cd <your-project>
pma codex
```

直接在该终端的 Codex TUI 中对话。看板会展示逐字请求/回复、工具 schema、调用和结果；PMA 不修改 `~/.codex/config.toml`，也不依赖本地 rollout 是否完整保存。

Codex 原生参数可以直接跟在后面：

```bash
pma codex resume --last
pma codex exec "检查这个仓库"
pma codex --dangerously-bypass-approvals-and-sandbox
```

最后一个命令会绕过审批和沙箱，只应在受信任的隔离环境中使用。`-c` 是 Codex 的配置覆盖参数，不表示 continue。

如果希望继续使用 Codex Desktop 原生界面，同时查看真实的完整上行与下行，请在**独立的系统终端**中执行：

```bash
cd <your-project>
pma codex desktop
```

在受支持的 macOS Codex Desktop 版本上，PMA 默认使用托管精确捕获。如果 Desktop 已经运行，PMA 会先说明正在运行的任务会被停止，并在获得同意后才做一次优雅重启。随后它启动 Desktop 内嵌、版本完全一致的 Codex App Server，并只在当前工作区随后新建的第一条 thread 的启动请求中注入临时捕获 provider 定义；App Server 的全局配置和其他 Desktop 会话保持原样。PMA 复用现有 Codex/ChatGPT 登录态，不改写 `~/.codex/config.toml`、不安装系统证书，也不会持久化认证值。

不要从当前 Codex Desktop 任务内嵌的终端启动这次重启；PMA 会检测并拒绝这种可能杀死自身控制器的操作。脚本中已经明确同意重启时，可使用 `pma codex desktop --capture exact --restart`。

不希望重启或当前平台暂不支持托管精确捕获时，使用只读 rollout 语义观察：

```bash
pma codex desktop --capture rollout
pma codex desktop -c
pma codex desktop --select
```

`desktop -c` 观察当前目录最近的会话，`--select` 只列出当前目录下可选择的会话；`--resume` 和 `--list` 用于高级历史观察。rollout 模式不是完整网络请求，正文也不会复制进 PMA SQLite。`pma codex capture -- ...` 暂作 Codex CLI 精确捕获的兼容别名。

如果要精确捕获一个已有 Desktop 会话，可以显式选择它；受管重启后再在 Desktop 中打开该会话，让 Codex 通过捕获 provider 冷恢复：

```bash
pma codex desktop --resume <thread-id> --capture exact
pma codex desktop --select --capture exact
```

已经加载的 thread 无法原地热切换 provider。PMA 会报告目标 thread 是否真的发生冷恢复和路由，不会把未改写的会话标成精确捕获。

## 快速开始：OpenCode

在希望观察的项目目录中，让 OpenCode 通过当前进程专属的精确代理启动：

```bash
cd <your-project>
pma opencode
```

之后继续在该终端的原生 OpenCode TUI 中工作。OpenCode 自己的参数会被原样透传：

```bash
pma opencode --continue
pma opencode --session <session-id>
pma opencode --model <provider/model>
```

PMA 只覆盖当前子进程的 `baseURL`，不改配置、不读 `auth.json`、不捕获其他会话，并要求显式 `baseURL`。

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

维护者发布公开版本时，请遵循[发布手册](docs/releasing.md)：它包含精确 Tag 三平台验证、首次 npm 包引导和后续 OIDC 可信发布流程。

这会运行跨平台核心 smoke gate，包括路径解析、doctor、源码安装、临时全局安装、维护/卸载、dashboard、Claude wrapper、发送消息、Trae CN 路由、持久化和请求树检查。

需要真实 Claude Code、OpenCode、OpenClaw、Codex、provider 或本机登录态的验证不放进默认 gate，维护者可参考 [手动集成 smoke 矩阵](docs/manual-integration-smoke-matrix.md)。

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
- [OpenCode CLI 适配计划与证据](docs/opencode-cli-adaptation-plan.md)
- [OpenClaw profile watch](docs/openclaw-profile-watch.md)
