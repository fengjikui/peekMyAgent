# Agent Send Service 契约

更新时间：2026-07-14

`src/server/agent-send-service.mjs` 管理 Viewer 底部输入框到本机 Agent CLI 的一次独立发送。它位于 Viewer Router 与 watch runtime/平台进程层之间，不拥有 watch 的创建、恢复或持久化。

## 调用链

```text
Agent Composer
  -> Viewer API Client
  -> POST /api/agent/send + agent-send intent
  -> ViewerRouter                 HTTP 安全与 body 校验
  -> AgentSendService             输入、命令、执行、脱敏响应
  -> resolveWatch(source_id)      WatchRuntimeService.resolveForSend 端口
  -> Claude Code / OpenClaw CLI   detached 本机进程
```

Router 继续拥有 loopback、Origin/Fetch Metadata、method、Content-Type、intent 和 body size 防护。Service 只接收已经解析的对象。

## Service 所有权

- `source_id` 与消息非空、最大 12000 字符限制；
- Claude Code `-p --output-format text [--resume]` 命令和临时 proxy settings；
- OpenClaw `agent --local [--session-key] --message` 命令；
- 不可访问 workspace 时回退到用户 home 或安全 cwd；
- 通过共享平台 helper 构造 Windows/macOS/Linux 子进程；
- 10 分钟超时、20 MiB stdout/stderr 上限；
- 对公开响应中的长命令参数做截断；
- 无论执行成功或失败都清理 Claude 临时 settings。

`WatchRuntimeService` 继续拥有 active watch 查找、SQLite watch 恢复、Capture Proxy 和 Store 写入。该依赖通过 `resolveWatch(sourceId)` 注入，因此 Agent Send Service 可以不启动 daemon 直接测试，也不会反向拥有 watch 生命周期。

## 关键不变量

1. 页面发送是 detached CLI 调用，不写入原始交互终端，也不让原终端后续输入继承这次上下文。
2. Claude Code 有 `conversation_id` 时使用 `--resume`；OpenClaw 有该字段时使用 `--session-key`。
3. 发送命令必须继续指向当前 watch 的 Capture Proxy，保证该独立请求仍可进入同一 Trace。
4. `paused` watch 允许独立发送，`stopped` watch 拒绝发送。
5. API 返回可以包含命令诊断信息，但长参数必须截断；Agent 子进程收到的消息不能被截断。
6. Service 不决定 source 如何恢复；找不到可用 watch 时只返回明确错误。

## 安全与隐私

该能力会在用户机器上启动 Agent CLI，并把页面消息发送给对应 provider，属于高敏副作用。HTTP route 必须保留 `x-peekmyagent-intent: agent-send`，不得将 dashboard 或该端点暴露到非 loopback 网络。API 输出中的 stdout/stderr 仍可能含用户数据，只能在本地受信任 Viewer 中消费。

## 验证

```bash
npm run smoke:agent-send-service-contract
npm run smoke:agent-send
npm run smoke:viewer-security
```

直接 Service smoke 锁定 Claude/OpenClaw 命令、环境、消息限制、脱敏和失败清理；HTTP smoke 使用 fake Claude 命令验证 intent、防止未授权 spawn、workspace 回退、dashboard 重启后的 persisted watch 恢复和 Capture Proxy 地址。
