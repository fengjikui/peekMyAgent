# peekMyAgent 用户使用手册

peekMyAgent（PMA）是一个本地优先的 Agent 请求观察工作台。它帮助你检查 Codex、Claude Code、OpenCode、CodeBuddy、OpenClaw 和自研 Harness 实际发送的 System / Developer 指令、消息、工具定义、工具调用与结果、模型参数和原始 JSON。

它不是用来“破解隐藏提示词”的工具，只用于你自己授权的本地 Agent 会话。

第一次使用请从[五分钟快速上手](quick-start.zh-CN.md)开始。那篇指南用一个无需项目背景的小例子走完安装、启动、观察、停止和清理。

## 按任务查找

| 我想做什么 | 从哪里开始 |
| --- | --- |
| 第一次成功观察一条会话 | [五分钟快速上手](quick-start.zh-CN.md) |
| 打开 Viewer，切换 Source 与会话 | [打开 Dashboard](#打开-dashboard) |
| 观察 Codex / Claude Code / OpenCode / CodeBuddy | [通过 PMA 启动 Agent](#推荐方式通过-peekmyagent-启动-agent) |
| 观察 OpenClaw | [使用 OpenClaw 隔离 profile 捕获](#使用-openclaw-隔离-profile-捕获) |
| 看懂请求、回复和工具闭环 | [图文与演示素材说明](visual-usage-guide.zh-CN.md) |
| 在长 Trace 中按 Turn / Request 定位 | [五分钟快速上手：两级导航](quick-start.zh-CN.md#6-长会话使用两级导航) |
| 用通用协议接入自研 Harness | [通过协议桥接入自研 Harness](#通过协议桥接入自研-harness) |
| 暂停、停止、清空或卸载 | [诊断、清理与卸载](#诊断清理与卸载) |
| 定位捕获不到、页面为空等问题 | [排障](#排障) |
| 开发专用 Harness adapter | [新 Harness 适配工作手册](new-harness-adaptation-playbook.md) |

## 适合谁使用

- 第一次接触 PMA、想迅速理解它解决什么问题的 Agent / Harness 使用者。
- 想观察 Codex、Claude Code、OpenCode、CodeBuddy 等 Harness 内部运行机制的开发者。
- 正在开发自有 Agent，想检查上行上下文、工具定义、模型参数、工具结果和协议响应的人。
- 想复盘子 Agent、多轮执行、上下文变化与异常行为的人。

## 当前可用能力

当前版本可以：

- 在本地 Web Viewer 中按 Source、项目和会话浏览 Capture。
- 通过 `pma codex`、`pma claude`、`pma opencode`、`pma codebuddy` 和 `pma openclaw chat` 启动受支持 Harness 并捕获请求。
- 通过 `pma observe ...` 观察读取 OpenAI-compatible 或 Anthropic-compatible base URL 环境变量的自研 Harness。
- 按厂商原生顺序查看 OpenAI Responses / Chat、Anthropic Messages 和 Google GenerateContent 证据，并跳回 Raw JSON。
- 关联工具调用与后续结果，使用 Turn / Request 两级导航浏览长 Trace，并查看子 Agent、翻译、上下文变化和大型载荷的按需内容。
- 暂停、恢复、停止 watch；停止时保留 Trace，或在明确确认后永久清空所有会话。

## 准备工作

确认 Node.js 24 或更新版本可用：

```bash
node --version
```

通过 npm 全局安装公开 Alpha：

```bash
npm install --global peekmyagent@next
pma doctor
```

以后重复执行同一条 npm 命令即可更新 Alpha。如果本机使用的 npm 镜像尚未同步该版本，可以明确指定官方 registry：

```bash
npm install --global peekmyagent@next --registry=https://registry.npmjs.org/
```

如果你要参与开发，再克隆项目并运行源码安装器：

```bash
git clone https://github.com/fengjikui/peekMyAgent.git
cd peekMyAgent
node scripts/install.mjs
```

安装器会执行 `npm install`、用 `npm install -g .` 从当前源码安装 CLI，然后运行 `pma doctor`。安装后会同时得到 `pma` 和 `peekmyagent` 两个命令；文档优先使用更短的 `pma`。如果只想预览，不修改当前机器：

```bash
node scripts/install.mjs --dry-run
```

源码安装器等价于：

```bash
npm install
npm install -g .
```

开发时也可以使用 `npm link`。

如果不想全局安装命令，也可以一直使用：

```bash
node bin/peekmyagent.mjs <command>
```

下面的示例默认使用 `pma`。完整命令 `peekmyagent` 仍然可用，行为相同。如果没有全局安装，在仓库目录里把命令前缀替换成 `node bin/peekmyagent.mjs` 即可；在任意目录使用时，替换成 `node /path/to/peekMyAgent/bin/peekmyagent.mjs` 或 Windows 上的 `node C:\path\to\peekMyAgent\bin\peekmyagent.mjs`。

## 打开 Dashboard

最简单的启动方式：

```bash
pma open
```

如果只想在终端拿到地址，不自动打开浏览器：

```bash
pma open --print
```

Dashboard 默认使用稳定端口：

```text
http://127.0.0.1:43110
```

页面结构：

- 左侧：会话/证据包列表。
- 中间：当前请求时间线。
- 右侧：Raw JSON 面板。
- 顶部：当前会话标题和统计信息。

## 推荐方式：通过 peekMyAgent 启动 Agent

最推荐的使用方式不是先启动 Agent 再尝试接管，而是把 `pma` 放在原 Agent 命令前面。这个前缀本身就是用户的显式授权：从这个进程开始，peekMyAgent 可以捕获它发出的模型请求。

### Codex CLI 与 Codex Desktop

在当前项目中精确捕获 Codex CLI：

```bash
pma codex
```

Codex 原生命令可以直接放在后面，例如 `pma codex resume --last` 或 `pma codex exec "检查这个仓库"`。PMA 不改写 `~/.codex/config.toml`，捕获覆盖只对这次子进程生效。

在受支持的 macOS 版本上观察 Codex Desktop：

```bash
pma codex desktop
```

默认尝试托管精确捕获；如果不希望重启 Desktop，或当前版本不支持，可以显式选择只读 rollout 观察：

```bash
pma codex desktop --capture rollout
```

rollout 不是完整网络请求，正文也不会复制进 PMA SQLite。精确捕获与 rollout 的选择、冷恢复限制和重启确认见[Codex Desktop 托管精确捕获设计](codex-desktop-managed-exact-capture.md)。

### Claude Code

启动 Claude Code：

```bash
pma claude
```

小写 `-c` / `--continue` 是 Claude Code 的原生“继续当前目录最近会话”参数；新建会话时不需要。需要继续时使用 `pma claude -c`。

如果你明确想让 Claude Code 跳过权限确认，可以把 Claude Code 自己的参数放在 `claude` 后面：

```bash
pma claude --dangerously-skip-permissions
```

这个参数属于 Claude Code，不属于 peekMyAgent。它会绕过 Claude Code 的常规权限检查，只建议在你信任的仓库里使用。

恢复指定 Claude Code 会话：

```bash
pma claude -r <session-id>
```

继续或恢复 Claude Code 时，如果当前项目里存在可能对应的历史监听，交互式终端会询问：

```text
检测到你正在恢复 Claude Code 会话：
  <session-id>

peekMyAgent 找到了可能对应的历史监听：
  1. 继续写入已有监听：<session-id>，状态 已停止，请求数 <n>
  2. 新建一个监听

你希望这次捕获写到哪里？
请选择 [1/2]，默认 1：
```

如果想跳过询问，可以显式指定策略：

```bash
pma --reuse claude -c
pma --ask claude -r <session-id>
```

默认规则：

- 普通 `pma claude`：直接新建监听。
- `claude -c/--continue` / `claude -r/--resume`：交互式终端询问复用还是新建，直接按回车接受默认选项 1，继续写入同一条监听。
- 上述复用规则同时适用于 proxy capture 和 OTel raw-body capture；两种模式都会在启动输出中明确标记 `(reused)` 或 `(new)`。
- 如果明确选择了复用，但目标监听已不存在，命令会报错而不是静默新建一条监听。
- 非交互环境：默认新建监听，避免脚本卡住；需要复用时使用 `--reuse`。

### OpenCode

在当前项目中启动 OpenCode：

```bash
pma opencode
```

PMA 只为这次 CLI / TUI 子进程注入临时 provider 覆盖，退出后自动撤销，不修改全局 OpenCode 配置。OpenCode 原生参数可以直接附在命令后；需要跳过可批准权限时见[各 Harness 的完全权限模式](#各-harness-的完全权限模式)。

### 通过协议桥接入自研 Harness

如果你的 Harness 已经通过某个环境变量读取 OpenAI-compatible 或 Anthropic-compatible 的 base URL，可以使用通用协议桥，不必先在 PMA 中新增 Agent 名称分支：

```bash
pma observe \
  --name my-agent \
  --base-url-env OPENAI_BASE_URL \
  --conversation-id my-agent-debug-1 \
  -- my-agent run
```

Anthropic-compatible 的写法相同，只需换成 Harness 实际读取的变量：

```bash
pma observe --name my-agent --base-url-env ANTHROPIC_BASE_URL -- python agent.py
```

运行契约：

- `--` 是强制边界；前面只能放 PMA 的 observe 选项，后面是完整原始子命令。
- `--name` 只是 Source 展示名，不参与协议判断。
- PMA 在启动前读取指定变量作为真实上游，再只对该子进程写入 watch proxy URL；父进程和用户配置不变。
- `--target-base-url` 可以显式提供真实上游，但仍必须用 `--base-url-env` 指明要给子进程覆写哪个变量。
- 原上游的 path prefix 会保留；OpenAI 常见的 `/v1` 不会在代理时丢失。
- API key、其他环境变量、stdin/stdout、SIGINT/SIGTERM 和退出码保持原样；PMA 自己的启动信息不打印子进程参数。
- 子进程正常或异常退出后，watch 都会停止，但 Trace 保留在本地。
- 只保证通用 OpenAI Responses/Chat 与 Anthropic Messages 的上行/下行解析；权限、命令、Skill、压缩和子 Agent 等 Harness 私有机制在没有证据时保持 unknown。

安全边界：上游必须是 `http` 或 `https`，且 URL 中不能嵌入用户名/密码、query 或 fragment。Capture Proxy 继续只绑定 loopback，认证 header 在持久化前使用现有规则脱敏。请勿把 key 放在子进程参数中；即使 PMA 不打印参数，其他进程工具仍可能观察 argv。

如果 Harness 不支持进程级 base URL 覆写，或者需要解释它的私有运行机制，请继续使用[新 Harness 适配工作手册](new-harness-adaptation-playbook.md)建立证据包和专用 adapter。

### CodeBuddy Code：复用当前 OpenCode 模型

安装 CodeBuddy 后，先在用户级 `~/.codebuddy/models.json` 中配置模型与认证，或在 shell 中提供同一上游的凭据：

```bash
npm install -g @tencent-ai/codebuddy-code
export CODEBUDDY_API_KEY='<你的 provider key>'
cd <your-project>
pma codebuddy
```

PMA 读取 OpenCode effective config 中的 model、provider 和 base URL，但不读取 `auth.json` 或复制任何认证。CodeBuddy 的 main、lite、reasoning 和 subagent model 只在该子进程内统一映射到当前 OpenCode model。当前验证范围是 CodeBuddy 2.130.0 的 OpenAI Chat Completions 路径。

Viewer 翻译会复用捕获请求里的 model，并让一次无工具、无持久化的 CodeBuddy 临时任务回到同一个用户级 `models.json` 条目；PMA 不会根据 Viewer 进程中的其他 provider 环境变量重新猜测，也不会读取或复制文件 API key。

```bash
pma codebuddy --continue
pma --reuse codebuddy --continue
pma codebuddy --resume <session-id>
pma codebuddy --fork-session
```

`--continue` 找到既有 PMA Source 并选择复用时，会转换成精确的原生 `--resume <session-id>`，避免恢复历史后错误创建新监控会话。`--fork-session` 始终创建新 Source。自定义已验证 endpoint 使用高级形式：

```bash
pma run codebuddy --target-base-url https://example.invalid/v1 --model example-model -- --print 'hello'
```

不要把 key 放在命令参数中。完整协议证据和限制见 [CodeBuddy Code 适配计划](codebuddy-code-adaptation-plan.md)。

### 各 Harness 的完全权限模式

下面的权限开关属于各 Harness 本身。peekMyAgent 只负责透传参数，或者使用明确命名的 OpenClaw 隔离 profile，不会给自身提升权限。

Codex CLI 单次跳过审批并关闭 Codex sandbox：

```bash
pma codex --dangerously-bypass-approvals-and-sandbox
```

Claude Code 单次绕过权限检查：

```bash
pma claude --dangerously-skip-permissions
```

CodeBuddy Code 单次绕过权限检查：

```bash
pma codebuddy --dangerously-skip-permissions
```

OpenCode 自动批准原本会询问的权限：

```bash
pma opencode --auto
```

`--auto` 不会覆盖配置中的显式 `deny`。如果确实需要 OpenCode 全部允许，可以在受信任项目的 `opencode.json` 中配置，然后运行 `pma opencode`：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": "allow"
}
```

OpenClaw 使用 PMA 的 `peekmyagent` 隔离 profile。先正常运行并退出一次 `pma openclaw chat`，让 PMA 初始化该 profile；然后开放完整工具 profile，并把 host exec 切换为 OpenClaw 的同步无确认模式：

```bash
openclaw --profile peekmyagent config set tools.profile full
openclaw --profile peekmyagent exec-policy preset yolo
pma openclaw chat
```

组织托管配置、显式 `deny` 和 per-agent policy 仍可能限制 OpenCode 或 OpenClaw。Codex Desktop 的权限需要在 Desktop 界面中选择，Codex CLI 的绕过参数不会影响 Desktop。

不要为了让示例看起来整齐而给每个 Harness 添加 `-C`。大写 `-C <目录>` / `--cd <目录>` 是 Codex CLI 独有的工作根目录参数；Claude Code、OpenCode 和 CodeBuddy 的小写 `-c` / `--continue` 则是继续最近会话。Codex 的小写 `-c` 是配置覆盖，恢复对话要使用 `resume`。

这些模式可能让 Agent 无需再次确认就修改文件、执行命令、调用已配置工具或访问网络。只应在受信任项目中使用，最好同时放在外部 sandbox 或一次性环境里。

启动 OpenClaw：

```bash
pma openclaw agent --session-key agent:main:my-session --message "hello"
```

如果不传 OpenClaw 子命令，默认会运行：

```bash
openclaw --profile peekmyagent chat
```

底层兼容入口仍然保留，适合调试或未来通用 Agent adapter：

```bash
pma run claude --watch reuse -- --continue
pma run openclaw -- chat
```

前缀命令会自动做这些事：

- 启动或复用本地 dashboard/daemon。
- 创建 live watch。
- Claude Code：启动前注入 `ANTHROPIC_BASE_URL`。
- OpenClaw：创建或使用 `peekmyagent` 隔离 profile，只 patch 这个 profile 的 provider `baseUrl`。
- 打印 dashboard URL 和 watch id。
- Agent 退出后自动把 watch 标记为 `已停止`。

如果想启动 Agent 后自动打开 dashboard：

```bash
pma --open claude -c
```

这个方式比会话内 fallback 更可靠，因为捕获配置在 Agent 进程启动前就已经准备好了。

## 查看内置证据包

启动开发证据包 Viewer 后，左侧会出现几个内置证据包：

- `OpenClaw 子代理`
- `OpenClaw 多轮会话`
- `Claude Code 子代理`
- `Claude Code proxy resume`

点击左侧条目即可切换。每个请求卡片里可以看：

- 当前用户输入或子任务输入。
- 工具调用和工具结果。
- system 摘要。
- tools 列表。
- message role 序列。
- Raw JSON。

右侧 Raw 面板默认显示完整捕获结构。点击任意请求卡片里的 `Raw` 按钮即可查看。

## Claude Code 会话内命令

Claude Code 会话内推荐使用 `/peekmyagent` 打开 dashboard 或获取 dashboard 地址。

如果 Claude Code 本来就是通过 `pma claude ...` 启动的，捕获已经开始，不需要再执行额外的 start/register 命令。

如果你已经在一个普通 Claude Code 会话里，仍然可以用 `/peekmyagent-status` 检查或注册当前 session，但它不能反向修改已经运行中的 Claude Code 父进程环境。要精确捕获，仍然建议退出后用：

```bash
pma claude -r <session-id>
```

首次使用时安装 Claude Code 集成：

```bash
pma install-claude-skill --commands
```

默认会安装：

- `~/.claude/skills/peekmyagent-control/SKILL.md`
- `~/.claude/commands/peekmyagent.md`
- `~/.claude/commands/peekmyagent-status.md`
- `~/.claude/commands/peekmyagent-pause.md`
- `~/.claude/commands/peekmyagent-resume.md`
- `~/.claude/commands/peekmyagent-stop.md`
- `~/.claude/commands/peekmyagent-clear.md`

安装新版命令时会清理旧的 `~/.claude/commands/peek-watch.md` 和 `~/.claude/skills/peek-watch/`。

## 诊断、清理与卸载

查看当前机器上的安装状态、状态目录、daemon/端口、Claude Code 配置和 slash command 安装情况：

```bash
pma doctor
pma doctor --json
```

清理所有已经捕获并存储的会话：

```bash
pma clear --all-sessions
```

压缩旧版 store 中的重复完整 raw body，但保留会话和分块缓存：

```bash
pma compact
```

`pma compact` 会先停止本地 dashboard daemon，避免压缩时发生并发写入；完成后可以用 `pma open` 重新打开 dashboard。需要限制范围时可以使用 `pma compact --watch <watch-id>`。

卸载 peekMyAgent 安装过的 Claude Code helper，但保留本地捕获数据：

```bash
pma uninstall --keep-data
```

卸载 helper 并删除 peekMyAgent 本地状态目录：

```bash
pma uninstall --remove-data
```

如果你是用源码安装器安装的，也可以从源码目录执行卸载器。它会先运行 `pma uninstall` 清理 helper / 数据，再运行 `npm uninstall -g peekmyagent` 移除全局 CLI 链接：

```bash
node scripts/uninstall.mjs --keep-data
node scripts/uninstall.mjs --remove-data
```

当前 `uninstall` 只删除 peekMyAgent 自己安装的 helper 和本地状态数据，不会改写用户的 Agent provider 配置。未来如果加入 Agent 级全局代理接管，需要由对应 adapter 提供单独的 restore 流程。

如果只想安装到当前项目：

```bash
pma install-claude-skill --scope project --commands
```

然后在 Claude Code 里输入：

```text
/peekmyagent
```

这个命令会在 Claude Code 当前会话内部运行：

```bash
pma open --print
```

常用控制命令可以直接自动补全：

```text
/peekmyagent-status
/peekmyagent-pause
/peekmyagent-resume
/peekmyagent-stop
/peekmyagent-clear
```

peekMyAgent 会读取 Claude Code 暴露给 Bash 工具的环境信息：

- `CLAUDE_CODE_SESSION_ID`
- `PWD`
- `CLAUDECODE`

然后把当前会话关联到 dashboard 左侧列表里。暂停时请求仍会转发，但不会保存请求内容；恢复后继续写入同一条 recording。

## 精确捕获的边界

`/peekmyagent-status` 可以识别并关联当前 Claude Code session，但它不能修改已经运行中的 Claude Code 父进程环境。

这意味着：

- 当前会话 ID 可以识别。
- Dashboard 左侧可以出现这个会话。
- 但要精确捕获后续 provider 请求，需要让 Claude Code 从代理地址启动或恢复。

CLI 可能会输出一个类似这样的恢复命令。macOS/Linux shell 写法：

```bash
ANTHROPIC_BASE_URL='http://127.0.0.1:<port>/watch/<watch_id>' claude --resume '<CLAUDE_CODE_SESSION_ID>'
```

Windows PowerShell 写法：

```powershell
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:<port>/watch/<watch_id>'
claude --resume '<CLAUDE_CODE_SESSION_ID>'
```

更推荐直接在同一项目目录运行：

```bash
pma claude -r '<CLAUDE_CODE_SESSION_ID>'
```

## 使用 OpenClaw 隔离 profile 捕获

OpenClaw 不应该通过修改原始配置来接入 peekMyAgent。推荐方式是使用专门的隔离 profile，例如 `peekmyagent`。

打开 dashboard：

```bash
pma open
```

首次使用可以安装 OpenClaw skill：

```bash
pma install-openclaw-skill --force
```

创建 OpenClaw watch，并只 patch 隔离 profile：

```bash
pma watch-current --agent openclaw --patch-openclaw
```

如果你已经知道 OpenClaw session key，可以传入：

```bash
pma watch-current --agent openclaw --patch-openclaw --session-key agent:main:my-session
```

这个命令会：

- 读取默认 OpenClaw 配置作为模板。
- 创建或使用 `peekmyagent` 隔离 profile。
- 只把隔离 profile 的 provider `baseUrl` 改到 peekMyAgent proxy。
- 保留原始 OpenClaw profile 不变。

然后使用输出中的 `openclaw_command_hint`，或者手动运行：

```bash
openclaw --profile peekmyagent agent --session-key agent:main:my-session --message "hello"
```

停止并恢复隔离 profile：

```bash
pma watch-current --agent openclaw --stop --session-key agent:main:my-session
```

停止、恢复并清空左侧 live watch：

```bash
pma watch-current --agent openclaw --clear --session-key agent:main:my-session
```

更详细的说明见 [OpenClaw profile 监听流程](openclaw-profile-watch.md)。

## 停止和清空监听

在 dashboard 里打开一个 live watch 后，会看到操作区：

- `仅停止监听`
- `停止并清空`

`仅停止监听` 会关闭本地代理，但保留已经捕获到的请求。适合你想停止记录，但还要继续查看证据。

`停止并清空` 会停止代理，并从左侧列表移除这个 live watch。适合这次观察已经结束，不需要保留页面条目。

停止后如果没有清空，页面会显示：

```text
监听已停止
```

并提供 `清空条目`。

也可以在 Claude Code 当前会话里用命令操作：

```bash
pma watch-current --agent claude-code --stop
```

停止并清空：

```bash
pma watch-current --agent claude-code --clear
```

同一个 Claude Code 会话重复运行普通 watch 命令时，会复用已有 active watch。需要替换时，先清空当前监听，再重新注册。

## 常用命令速查

打开 dashboard：

```bash
pma open
```

安装 Claude Code skill 和 slash command：

```bash
pma install-claude-skill --commands
```

在当前 Claude Code session 检查/注册 recording：

```bash
pma watch-current --agent claude-code
```

暂停当前 Claude Code session 的 recording：

```bash
pma watch-current --agent claude-code --pause
```

恢复当前 Claude Code session 的 recording：

```bash
pma watch-current --agent claude-code --resume
```

停止当前 Claude Code session 的 recording 但保留数据：

```bash
pma watch-current --agent claude-code --stop
```

停止并清空当前 Claude Code session 的 recording：

```bash
pma watch-current --agent claude-code --clear
```

查看 CLI 帮助：

```bash
pma --help
```

## 排障

### 提示找不到 pma 或 peekmyagent

在仓库目录执行：

```bash
node scripts/install.mjs
```

或者改用：

```bash
node bin/peekmyagent.mjs open
```

### 提示 no running dashboard found

打开 dashboard：

```bash
pma open
```

Dashboard 启动后会写入本地 registry：

```text
~/.peekmyagent/viewer.json
```

`watch-current` 会通过这个文件找到当前 dashboard。

### 页面没有出现 live watch

检查三件事：

1. Dashboard/daemon 是否仍在运行。
2. `watch-current` 是否指向同一个 dashboard URL。
3. Claude Code 内部是否能访问 `peekmyagent` 命令。

如果需要手动指定 dashboard：

```bash
pma watch-current --viewer-url http://127.0.0.1:52502
```

### 左侧出现重复 watch

正常情况下，同一个 Claude Code session 会复用 active watch。可以在页面里对不需要的条目点击 `停止并清空`。

### 能注册 session，但捕获不到请求

这是当前 Claude Code 集成的正常边界。注册当前 session 不等于改变已经运行中的 Claude Code 网络代理。

更推荐使用 wrapper 重新进入同一个 session：

```bash
pma claude -r '<session_id>'
```

如果必须手动设置代理，macOS/Linux shell 写法：

```bash
ANTHROPIC_BASE_URL='<proxy_base_url>' claude --resume '<session_id>'
```

Windows PowerShell 写法：

```powershell
$env:ANTHROPIC_BASE_URL = '<proxy_base_url>'
claude --resume '<session_id>'
```

之后新的模型请求才会经过 peekMyAgent 代理。

### 担心 token 或密钥泄露

peekMyAgent 默认只在本机运行 dashboard 和代理。捕获记录中会对常见敏感 header 做脱敏，例如 authorization、cookie、token 等字段。

仍然需要注意：

- 不要随意导出或分享 Raw JSON。
- 不要把包含敏感信息的截图发到公开渠道。
- 调试 Claude Code 环境变量时不要打印完整 `env`，其中可能包含 provider token。

### 分享或导入一次 Trace

dashboard 左侧会话菜单里的 `导出 Trace` 会把当前会话导出为 `.peektrace.json.gz`。这个文件可以发给其他人，或者在另一台机器的 dashboard 里通过 `导入 Trace` 打开。

导入后的 Trace 是只读会话：

- 不会继续监听原来的 Agent。
- 不显示发送框能力。
- 可以查看时间线、Raw JSON、System、Tools、Response、Tool use / Tool result 和多 Agent 结构。
- 删除导入会话只删除本机导入副本，不影响导出者机器上的数据。

注意：Trace 文件可能包含 system prompt、tool schema、工具参数、本机路径和模型回复。公开分享前请先确认里面没有敏感信息。

## 当前限制

- live watch 捕获请求会写入本地 SQLite store；dashboard 重新打开后可以从 stored source 查看已捕获请求。当前阶段 daemon 重启仍可能中断正在进行的流式请求。
- `watch-current` 当前对 Claude Code 支持最好；OpenClaw 仍以 proxy/session-key 实验路径为主。
- Trace 包导出/导入已经支持基础只读查看；导出前隐私审查、自动清理和更细粒度隐私策略仍在后续产品化范围内。
- 当前 UI 中的 `检查敏感信息` 还是早期入口，不等于完整隐私审计产品。

## 推荐使用流程

第一次使用：

```bash
git clone <repo-url>
cd peekMyAgent
node scripts/install.mjs
pma install-claude-skill --commands
pma open
```

日常使用：

1. 在项目目录用 `pma claude -c` 或 `pma claude -r <session-id>` 进入 Claude Code。
2. 正常和 Claude Code 对话；捕获会自动写入当前项目对应的会话。
3. 想查看时在 Claude Code 里执行 `/peekmyagent`，或在任意终端执行 `pma open`。
4. 回到 dashboard 查看请求时间线和 Raw JSON。
5. Agent 退出后监听自动停止，但已捕获数据仍保留在左侧会话列表。
