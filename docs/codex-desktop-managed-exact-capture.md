# 托管 Codex Desktop 精确捕获

更新时间：2026-07-19

状态：macOS 首版与 thread 选择性路由均已实现，并通过隔离 fake Desktop/App Server/upstream 回归及真实内嵌 App Server 无模型请求探针；真实账号验收需由外部系统终端执行，不能让承载当前开发任务的 Codex Desktop 重启自身。

## 用户目标

用户继续在 Codex Desktop 原生对话框中工作，同时让 peekMyAgent 捕获该受管 Desktop 进程真正发送的 Responses API 上行与下行。该能力不是附着任意已经运行的进程，也不是系统级 HTTPS 中间人。

```text
external Terminal: pma codex desktop
  -> create exact watch and local Capture Proxy route
  -> start Desktop-bundled, version-matched codex app-server
  -> app-server starts without a PMA provider or global config override
  -> relay injects a thread-local provider definition into one selected start or cold resume
  -> ask before gracefully quitting an existing Desktop
  -> launch the native Desktop executable with one relay URL in its environment
  -> user chats in Desktop; only the selected thread flows through Capture Proxy
  -> Desktop exits; relay, app-server, token file and active watch are cleaned
```

## 为什么需要一次重启

已经运行的 Desktop 与它原有 app-server 的连接在进程启动时建立，后续 CLI 子进程的环境变量不会回写到该进程。PMA 因此只能在新启动的 Desktop 进程环境中设置 `CODEX_APP_SERVER_WS_URL`。如果 Desktop 已经运行，交互命令默认提供三个选择：

1. 同意优雅重启，进入精确捕获。
2. 不重启，改用 rollout 语义观察。
3. 取消，不做任何修改。

脚本可用 `--capture exact --restart` 明确预授权。若 `pma` 是正在运行的 Codex Desktop 的后代进程，命令直接拒绝重启，要求改从外部 Terminal 执行。

## 两段本地能力边界

Desktop 与 app-server 之间并非直接暴露一个裸 WebSocket：

- **Desktop -> relay**：relay 只绑定 `127.0.0.1`，URL 路径含 256-bit 随机 capability；错误路径和非 loopback 连接被拒绝。
- **relay -> app-server**：app-server 监听另一随机 loopback 端口并启用 `--ws-auth capability-token`。后端 token 只存在于权限为 `0600` 的临时文件和 relay 内存中；relay 删除客户端自带 Authorization 后再注入正确 Bearer token。
- relay 只对有界 WebSocket 文本消息解析 JSON-RPC，并只允许改写 `thread/start`、`thread/resume`、`thread/fork` 的 `modelProvider` 与 thread-local `config.model_providers`；其他方法和其他 thread 逐字转发。解析出的控制消息只存在于内存，不写 Trace、不进日志。模型 request/response 仍由既有 Capture Proxy 按 provenance、大小限制和脱敏规则持久化。
- relay 在启用选择性路由时拒绝压缩/保留 opcode、无效 UTF-8、异常 mask 和超过 64 MiB 的消息；后端握手会移除扩展协商，避免解析压缩帧。协议错误关闭本次连接并只增加计数，不回显正文。
- Desktop 只看到 relay capability；app-server capability 不放进 Desktop 参数或环境。

## 配置与认证

- app-server 使用 Desktop bundle 内嵌的 Codex executable，不使用可能版本不同的全局 `codex`。
- app-server 继承当前 `CODEX_HOME`，因此复用用户已经可用的 Codex/ChatGPT 登录态。
- app-server 启动参数不注册捕获 provider。relay 只在目标 thread 的创建、冷恢复或 fork 请求中注入 `modelProvider`，并把 provider 定义、loopback base URL、Responses API 和 HTTP-only 开关合并进该请求的 `config.model_providers`。
- 不改写 `~/.codex/config.toml`，不复制认证文件，不安装 CA，不设置系统代理。
- Capture Proxy 只允许已经验证的 first-party Codex 路由；认证值只在转发内存中存在，持久化前统一脱敏。

## 线程级配置边界

2026-07-19 的协议、源码与隔离 App Server 实验确认：Codex 的确存在每个 thread 自己的运行配置，但不同字段的生效时机不同。

- `thread/start`、冷态 `thread/resume` 和 `thread/fork` 可以指定 `modelProvider`，并可携带 thread 级 `config`。provider 与 base URL 在创建或冷恢复 Session 时解析。
- `turn/start` 和 `thread/settings/update` 可以为特定 thread 调整 model、reasoning effort、cwd、approval、sandbox/permissions、personality、service tier 等下一轮设置，但没有 provider/base URL 字段。
- 已加载且仍被 Desktop 订阅的 thread 不会在 `thread/resume` 时切换 provider；App Server 会继续使用原 provider，并记录 override 被忽略。
- 全局 `config/batchWrite` 的 `reloadUserConfig` 会刷新所有已加载 thread 的 user config layer，不是单 thread 控制面；Session 已构造的 provider 仍保持不变。
- `$CODEX_HOME/state_5.sqlite` 与 rollout 会记录 `model_provider`、model、cwd、sandbox 和 approval 等元数据，但这些是持久化索引与冷恢复依据，不是运行中 thread 的热配置入口。PMA 不直接改写 Codex 私有数据库。

当前实现完全采用 thread-local 注入：App Server 进程不知道 `peekmyagent_http`，relay 只对一条目标链路同时注入 provider 选择与定义。默认 `pma codex desktop` 捕获当前工作区随后启动的第一条新 thread；`--resume <id> --capture exact`、`-c --capture exact` 或 `--select --capture exact` 捕获明确选择的既有 thread，并在它被冷恢复时生效。该 thread 后续 fork 出来的 child 会沿同一捕获链路继续绑定；其他新建、恢复或并行 thread 保持用户原 provider。

这个范围收窄不等于热附着。一个已经加载且仍被 Desktop 订阅的 thread 会忽略 resume 的 provider override，因此 PMA 重启后需要用户在 Desktop 中打开目标会话，使它从新 App Server 冷恢复；命令行会明确提示这一点。如果目标没有发生冷恢复，PMA 只报告“尚未捕获”，不会把未改写的流量误报为精确 Trace。

## 失败与恢复

1. PMA 先启动并验证 app-server 与 relay，再触碰现有 Desktop。
2. 只请求正常退出，不 force-kill。
3. Desktop 未退出时中止精确启动；恢复路径不会用 `open -n` 制造第二个实例。
4. 受管 Desktop 或 app-server 异常时，先停止受管实例并清理临时基础设施，再尝试无 override 地正常重开 Desktop。
5. `SIGINT`、`SIGTERM` 和 POSIX `SIGHUP` 会转发给受管 Desktop，随后走统一 finally 清理。
6. 进程被 `SIGKILL` 或机器掉电时无法执行 finally；能力 token 仍是随机、仅本用户可读且只绑定 loopback，后续维护可清理遗留的 `peekmyagent-codex-app-server-*` 临时目录。

## 当前范围

- 产品化的受管精确启动目前仅支持 macOS Codex Desktop。
- `auto` 在能力不可用、平台不支持或非交互环境无法获得重启同意时，明确说明原因并退回 rollout。
- 显式 `--capture exact` 不静默退回语义证据。
- `-c`、`--select` 和 `--resume` 默认仍是零重启 rollout 只读观察；显式附加 `--capture exact` 时，改为重启后仅捕获该目标 thread。`--list` 只列会话，不启动捕获。
- 不承诺 in-place 附着任意已运行 Desktop，不承诺私有 first-party route 永久稳定。

## 验证

确定性门禁不读取真实账号、不修改真实配置，也不重启真实 Desktop：

```bash
npm run smoke:codex-app-server-relay
npm run smoke:codex-app-server-thread-routing
npm run smoke:codex-desktop-installation
npm run smoke:codex-desktop-managed-session
npm run smoke:run-codex-desktop-exact
npm run smoke:run-codex-desktop
```

额外的 `npm run experiment:codex-app-server-thread-routing-real` 使用临时 `CODEX_HOME` 和真实 Desktop 内嵌 App Server 验证 provider 注入结果，并断言 App Server 启动参数不含 PMA provider；它不读取真实会话、不发模型请求，也不重启 Desktop。

真实验收按[人工集成矩阵](manual-integration-smoke-matrix.md)执行，并清理测试产生的 watch/Trace。
