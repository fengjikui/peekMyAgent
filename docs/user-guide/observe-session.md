# 观察一次真实 Agent 会话

这篇只回答一个问题：怎样让一次真实 Harness 会话稳定进入 PMA，并在 Viewer 中找到它。

第一次使用建议先完成[五分钟快速上手](../quick-start.zh-CN.md)。那条最小轨迹不会要求你理解任何业务背景。

## 1. 准备非敏感测试目录

不要从公司的私有仓库、真实用户数据或含有凭据的项目开始。建立一个只有虚构文件的目录，并在需要跳过 Harness 权限确认时再套一层容器、虚拟机或一次性环境。

```bash
mkdir hello-agent
cd hello-agent
```

## 2. 安装并打开 Viewer

PMA 需要 Node.js 24 或更新版本：

```bash
node --version
npm install --global peekmyagent@next
pma doctor
pma open
```

默认 Viewer 地址是 `http://127.0.0.1:43110`。它应该只绑定环回地址，不要直接暴露到公网。

如果只想输出地址、不自动打开浏览器：

```bash
pma open --print
```

## 3. 通过 PMA 启动 Harness

选择一个 Harness，不要同时执行所有示例：

| Harness | 普通启动 | 受信任测试环境中的最大权限模式 |
| --- | --- | --- |
| Codex CLI | `pma codex` | `pma codex --dangerously-bypass-approvals-and-sandbox` |
| Claude Code | `pma claude` | `pma claude --dangerously-skip-permissions` |
| OpenCode | `pma opencode` | `pma opencode --auto` |
| CodeBuddy Code | `pma codebuddy` | `pma codebuddy --dangerously-skip-permissions` |
| OpenClaw | `pma openclaw chat` | 使用 PMA 的 `peekmyagent` 隔离 profile，见[安全、权限与清理](privacy-cleanup.md) |

这些权限参数属于各 Harness，PMA 只负责透传。OpenCode 的 `--auto` 不能覆盖显式 `deny`；Codex Desktop 的权限由 Desktop 界面控制，CLI 参数不会跨过去。

每个 Harness 的精确捕获、恢复和版本边界见[观察官方支持的 Harness](supported-harnesses.md)。

### `-c` 与 `-C` 不是统一参数

- Codex 的大写 `-C <目录>` / `--cd <目录>` 用于指定工作根目录。
- Claude Code、OpenCode 和 CodeBuddy 的小写 `-c` / `--continue` 表示继续最近会话。
- Codex 的小写 `-c` 是配置覆盖；恢复对话使用 `resume`。

已经 `cd` 到测试目录时，不需要再给 Codex 重复添加 `-C`。不要为了命令看起来整齐而给所有 Harness 添加同名参数。

## 4. 发送容易核对的任务

最适合第一条轨迹的任务同时满足三个条件：无需业务背景、必然产生工具调用、结果容易肉眼核对。例如：

```text
请先列出当前目录，再读取 README.md 的“项目目标”部分，最后用一句话说明这个项目做什么。
```

真实 Agent 可能选择不同工具名或合并步骤。PMA 的职责是忠实呈现真实 Harness 行为，不是把它改造成预设剧本。

## 5. 在 Viewer 中定位 Source

Viewer 的基本结构是：

- 左栏：按 Agent、项目和会话组织的 Source 列表；
- 中栏：用户 Turn、模型 Request、工具交换和模型回复；
- 右栏：选中 Request 的证据详情、协议视图与 Raw Inspector；
- 右侧 Turn Rail：在长会话中按用户轮次跳转；
- 中栏 Request Rail：当前 Turn 至少有 5 次主线 Request 时出现，用于轮内定位。

推荐浏览顺序是“左栏选 Source → Turn Rail 选轮次 → Request Rail 选请求 → 点击详情看证据”。

## 6. 继续或恢复会话

常用例子：

```bash
pma codex resume --last
pma claude -c
pma codebuddy --continue
```

Claude Code 或 CodeBuddy 恢复会话时，PMA 可能询问是继续写入历史 Source，还是建立新 Source。交互式终端默认优先复用；非交互环境默认新建，避免脚本等待输入。需要明确控制时使用顶层 `--reuse` 或 `--ask`。

## 7. 停止观察

由 PMA 启动的 Agent 退出后，对应 watch 会自动停止，但 Trace 会保留。停止 Dashboard：

```bash
pma shutdown
```

这不会删除已捕获内容。删除数据和完整卸载见[安全、权限与清理](privacy-cleanup.md)。

## 下一步

- [看懂请求、回复和上下文变化](requests-context.md)
- [看懂工具调用与迟到结果](tools-results.md)
- [看懂子 Agent 与多 Agent 协作](subagents.md)
