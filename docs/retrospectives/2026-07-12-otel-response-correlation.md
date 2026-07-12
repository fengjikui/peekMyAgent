# OTel request/response 关联可靠性复盘

日期：2026-07-12

## 背景

peekMyAgent 使用 Claude Code 的 `OTEL_LOG_RAW_API_BODIES=file:<dir>` 获取未截断 request/response JSON。旧实现分别按文件修改时间排序，再把第 N 个 request 与第 N 个 response 配对。

正文确实来自 Claude Code 官方遥测，但“正文真实”并不能证明“request 与 response 的归属正确”。并发子 Agent、乱序完成和 API retry 都可能让两个序列顺序不同。

## 根因

raw-body 文件名没有共同 ID：

- request 文件为 `<uuid>.request.json`；
- response 文件为 `<request_id>.response.json`。

单看文件无法建立确定关联。旧代码仍把 capture 标为 `exact`，把内容 fidelity 与关联 confidence 混成了一个概念。

## 实验

在 macOS、Claude Code 2.1.207 上启动临时本地 OTLP HTTP/JSON collector，使用无工具提示 `Reply exactly OK. Do not use tools.`。实验仅输出事件字段摘要，raw body 与 collector 临时目录结束后删除。

观察到：

- `api_request_body` 与对应 `api_response_body` 具有相同 `traceId` 和 `spanId`；
- 两者分别携带各自的 `body_ref`；
- `event.sequence`、`prompt.id` 和 `query_source` 可作为排序与诊断证据；
- `OTEL_EXPORTER_OTLP_HEADERS=x-peekmyagent-intent=otel-event-ingest` 能被 Claude Code 正确发送到本地 collector。

## 修复

1. wrapper 为 OTel 模式启用增强 tracing，并把 logs/traces 发到 daemon 的 loopback 专用入口。
2. daemon 只保留 raw-body 事件的最小关联字段，不保存完整 trace payload。
3. 有共同 `traceId + spanId` 时精确配对。
4. 同一 span 有多个 request attempt 时，response 归属最后一次 request body event，标为 `high`，较早 attempt 不伪造 response。
5. 周期性 ingest 不执行顺序猜测；进程退出的最终 ingest 才为旧版本或事件缺失执行 `file_write_order` 回退，并标为 `heuristic`。
6. provenance v1 分别记录 request/response fidelity 与 association confidence。

## 验证

确定性测试覆盖：

- request/response 正常顺序；
- 两个并发请求反向完成；
- 同一 span 多次 retry；
- request 缺少 response；
- OTel event endpoint 缺少 intent header；
- wrapper 注入 OTel endpoint，fake Claude 上报事件，再由 Viewer ingest 和 SQLite 展示。

执行命令：

```bash
npm run smoke:otel-capture
npm run smoke:otel-ingest
npm run smoke:otel-e2e
npm run release:check:macos
```

最终 macOS release gate 在 Node.js 24.14.0、arm64 上通过，约 50 项 smoke 全绿。npm 安装包清单保持无 docs/tmp/private artifacts；因新增两个必需核心模块，受控文件预算由 40 精确调整为 42。

## 剩余风险

- 较老 Claude Code 或禁用增强 telemetry 时仍只能启用 heuristic 回退。
- daemon 在运行中重启会丢失尚未写入 capture 的内存事件索引；最终 ingest 仍能保留正文，但配对可能降级。
- provenance 目前先覆盖 OTel；Proxy、OpenClaw、导入 Trace 尚未统一迁移。
- event index 需要持续受数量上限约束，避免异常进程长期向 daemon 写入高基数事件。

## 后续

下一阶段应扩展统一 provenance DTO，并建立数据库 migration baseline。完成共享契约后，再拆分 Viewer Server 和 Client。
