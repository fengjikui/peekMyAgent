# 观察官方支持的 Harness

最可靠的捕获方式是在 Harness 启动前把 `pma` 放到原命令前面。这个前缀是用户对当前子进程的明确授权，PMA 只对该次运行建立 Capture，不应把配置永久扩散到其他项目或进程。

## Codex CLI

新会话：

```bash
pma codex
```

Codex 原生命令和参数放在后面：

```bash
pma codex resume --last
pma codex exec "检查这个公开测试目录"
pma codex -C <test-directory>
```

PMA 不修改 `~/.codex/config.toml`；代理覆盖只对这次 Codex 子进程生效。需要在受信任测试环境中跳过审批与 Codex sandbox：

```bash
pma codex --dangerously-bypass-approvals-and-sandbox
```

## Codex Desktop

受支持的 macOS 环境可以使用托管精确捕获：

```bash
pma codex desktop
```

如果不希望重启 Desktop，或当前版本不支持精确路径，显式选择只读 rollout 观察：

```bash
pma codex desktop --capture rollout
```

选择已有 Desktop 会话：

```bash
pma codex desktop --select
pma codex desktop --select --capture exact
```

rollout 是语义观察证据，不是完整网络请求；正文也不会复制进 PMA SQLite。精确捕获的重启、冷恢复和选择边界见[Codex Desktop 托管精确捕获设计](../codex-desktop-managed-exact-capture.md)。Desktop 权限在 Desktop 界面中管理，Codex CLI 的 bypass 参数不会影响它。

## Claude Code

新会话：

```bash
pma claude
```

继续当前目录最近会话，或恢复指定会话：

```bash
pma claude -c
pma claude -r <session-id>
```

恢复时交互式终端会询问复用历史 PMA Source 还是新建 Source。直接回车接受默认复用；脚本环境默认新建，避免等待输入。需要明确控制：

```bash
pma --reuse claude -c
pma --ask claude -r <session-id>
```

完全权限模式：

```bash
pma claude --dangerously-skip-permissions
```

安装 Claude Code 内的 `/peekmyagent` 等控制命令：

```bash
pma install-claude-skill --commands
```

会话内注册可以识别 session，但无法反向修改已经运行的 Claude Code 父进程环境。要精确捕获，优先退出后通过 `pma claude -r <session-id>` 恢复。

## OpenCode

```bash
pma opencode
pma opencode --continue
```

PMA 只给当前 CLI/TUI 子进程注入临时 provider 覆盖，退出后自动撤销，不修改用户全局 OpenCode 配置。

自动批准可批准权限：

```bash
pma opencode --auto
```

`--auto` 不能覆盖显式 `deny`。OpenCode 原生 title generation、主 Agent、child Agent、command 和 summarize 等语义只有在当前证据支持时才会进入 Viewer；未知 provider driver 或任意 slash command 不从单个实例外推。

## CodeBuddy Code

安装并完成 CodeBuddy 自己的模型/认证配置后：

```bash
pma codebuddy
pma codebuddy --continue
pma codebuddy --resume <session-id>
pma codebuddy --fork-session
```

PMA 会为这个子进程复用当前 OpenCode effective model/provider 信息，但不读取 OpenCode `auth.json`，也不把一个 Harness 的 key 复制给另一个 Harness。CodeBuddy 用户级 `models.json` 的原文件不会被改写；需要的 URL 映射只发生在当前进程内存读取路径。

当前真实证据覆盖 CodeBuddy 2.131.0 的 streaming OpenAI Chat Completions、原生 session identity、Read 工具循环、同步 Explore 子 Agent 和 resume 多轮。其他版本或私有 provider 仍应以实际 Capture 为准。

完全权限模式：

```bash
pma codebuddy --dangerously-skip-permissions
```

更完整证据和限制见[CodeBuddy Code 适配计划](../codebuddy-code-adaptation-plan.md)。

## OpenClaw

```bash
pma openclaw chat
```

PMA 创建或使用明确命名的 `peekmyagent` 隔离 profile，只 patch 这个 profile 的 provider base URL，不应修改默认 profile。

如果需要完整工具 profile 和无需确认的 host exec，先运行并退出一次让 PMA 初始化 profile，再在受信任环境执行：

```bash
openclaw --profile peekmyagent config set tools.profile full
openclaw --profile peekmyagent exec-policy preset yolo
pma openclaw chat
```

也可以给出明确 session key：

```bash
pma openclaw agent --session-key agent:main:my-session --message "hello"
```

OpenClaw 的组织策略、per-agent policy 和显式限制仍可能覆盖 profile 默认值。

## 自动打开 Viewer

在 Harness 启动后自动打开 Dashboard：

```bash
pma --open claude -c
```

同样的顶层 `--open` 可以与其他 wrapper 组合。无论是否自动打开，Harness 退出后 watch 都会停止并保留 Trace。

## 如何判断捕获完整度

在 Viewer 中检查 Source 的 transport/provenance：

- exact proxy 通常能提供完整 HTTP 请求和响应；
- OTel 取决于 Harness 实际导出的 raw body 和生命周期事件；
- rollout 只提供可证明的语义观察，不应冒充完整网络协议；
- imported Trace 只读，不会继续监听。

任何 Harness 特有结论都应同时核对 Raw、adapter 文档和实际版本。
