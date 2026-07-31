# 完全权限模式、隐私、安全与清理

PMA 会接触 Agent 的上行上下文、工具 schema、工具参数、工具结果和模型回复。它默认本地优先、代理绑定 loopback，并对常见敏感 header 脱敏；但这不等于任意 Capture、截图或 Trace 都可以公开。

## 完全权限属于 Harness

下面的开关不会给 PMA 自身提权，而是传给对应 Harness：

```bash
pma codex --dangerously-bypass-approvals-and-sandbox
pma claude --dangerously-skip-permissions
pma codebuddy --dangerously-skip-permissions
pma opencode --auto
```

它们可能允许 Agent 无需再次确认就修改文件、执行命令或访问已配置网络。只用于受信任的非敏感测试目录，最好外面还有容器、虚拟机或一次性环境。

OpenCode 的 `--auto` 不能覆盖显式 `deny`。全部允许需要在受信任项目的 `opencode.json` 中明确配置：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": "allow"
}
```

组织托管策略仍可能限制实际权限。

## OpenClaw 隔离 profile

PMA 不应改写默认 OpenClaw profile。先正常启动并退出一次，让 PMA 初始化 `peekmyagent` profile：

```bash
pma openclaw chat
```

只在受信任测试环境中开放完整工具与 host exec：

```bash
openclaw --profile peekmyagent config set tools.profile full
openclaw --profile peekmyagent exec-policy preset yolo
pma openclaw chat
```

这些设置只属于 `peekmyagent` 隔离 profile。per-agent policy 或组织策略仍可能继续限制能力。

## Capture 中可能包含什么

- System / Developer 指令；
- 用户和 Assistant 历史；
- 工具 schema、参数与结果；
- 模型、推理参数、metadata 与 usage；
- 工作目录、本地文件路径和命令输出；
- 子 Agent prompt、结果与关联 id；
- 原始协议与响应错误。

常见 `authorization`、cookie、token header 会脱敏，但正文中的 key、源码或用户数据不能仅依赖 header 规则保护。

## 暂停、停止与保留

由 PMA 启动的 Harness 退出后 watch 自动停止，Trace 保留。停止 Dashboard：

```bash
pma shutdown
```

Claude Code 会话内控制可以使用：

```text
/peekmyagent-pause
/peekmyagent-resume
/peekmyagent-stop
/peekmyagent-clear
```

暂停时请求继续转发，但不会保存新的请求内容；恢复后继续写入同一 recording。停止保留数据，清空才删除对应 recording。

## 清理本地数据

永久清空所有已捕获会话：

```bash
pma clear --all-sessions
```

压缩旧 store 中重复 raw body、保留会话与缓存：

```bash
pma compact
pma compact --watch <watch-id>
```

`compact` 会先停止本地 Dashboard daemon，结束后用 `pma open` 重新打开。

## 卸载

卸载 PMA helper、保留本地 Capture：

```bash
pma uninstall --keep-data
```

卸载 helper 并删除 PMA 本地状态：

```bash
pma uninstall --remove-data
```

源码安装还可以执行：

```bash
node scripts/uninstall.mjs --keep-data
node scripts/uninstall.mjs --remove-data
```

当前卸载流程只处理 PMA 自己安装的 helper 和状态目录，不应删除用户项目或改写用户的默认 Agent provider 配置。

## 导出与分享 Trace

会话菜单可以导出 `.peektrace.json.gz`，另一台机器通过 `导入 Trace` 只读查看。导入副本不会继续监听原 Agent，删除导入副本也不会影响导出者机器。

分享前逐项检查：

- Source 名称、workspace 和路径；
- System、Harness、History 和 Message；
- Tools schema、参数与结果；
- Raw headers、body、response 和 metadata；
- 子 Agent prompt 与结果；
- 翻译缓存和截图标注；
- 是否出现真实 API key、提示词、源码或不可公开 Capture。

当前“检查敏感信息”仍是早期入口，不等于完整隐私审计产品。公开发布前必须人工复核。
