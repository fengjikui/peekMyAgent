# OTel Ingest Service 契约

更新时间：2026-07-14

`src/server/otel-ingest-service.mjs` 管理 Claude Code OTel raw-body 数据进入持久化 Store 的有状态业务流程。它位于纯 OTel 解析层与 Viewer HTTP Router 之间。

## 分层

```text
Claude Code wrapper
  -> /api/capture/otel/events     raw-body 关联事件
  -> /api/capture/otel            dump 目录刷新/最终刷新
  -> ViewerRouter                 method/intent/body/watch-id 校验
  -> OtelIngestService            缓冲、配对策略、watch DTO、幂等写入
  -> core/otel-events.mjs          事件提取与去重
  -> core/otel-capture.mjs         文件扫描、request/response 配对、CaptureRecord
  -> PersistenceStore
```

HTTP Router 仍是 loopback、intent、Content-Type 和 body size 的安全边界。Service 不读取 Node request/response，也不决定 URL 或 header。

## Service 所有权

- 每个 `watch_id` 的短期 body-event 缓冲；
- 事件缓冲上限和最旧 watch 淘汰；
- incremental/final ingest 的 response 配对策略；
- OTel watch 元数据、Source ID 和连续 request index；
- request 幂等插入，以及迟到 response 对已有 request 的更新；
- final ingest 后释放该 watch 的关联事件。

`core/otel-events.mjs` 继续拥有 OTLP log record 的字段解释。`core/otel-capture.mjs` 继续拥有 dump 扫描、provenance 与 trace/span/legacy 配对算法。不得把这些纯协议事实复制进 Service。

## 关键不变量

1. `event_correlation_enabled=true` 的增量刷新只接受事件证据，不提前按文件顺序误配 response。
2. final ingest 允许旧版本或事件缺失时使用位置回退，并在 provenance 中保留 heuristic 事实。
3. 已存在 request 不重新分配 index；新 request 从 Store 的 `nextRequestIndex(watchId)` 连续递增。
4. request 可能先落盘、response 后到；每次 refresh 都允许补写 response 和关联 provenance。
5. 默认最多缓冲 32 个 watch、每个 watch 2400 个事件。刷新已有 watch 会更新其淘汰顺序。
6. final ingest 必须删除该 watch 的内存事件，wrapper 必须删除自己创建的临时 dump 目录。

## 验证

```bash
npm run smoke:otel-ingest-service-contract
npm run smoke:otel-ingest
npm run smoke:otel-capture
npm run smoke:otel-e2e
```

直接 Service smoke 不启动 HTTP，锁定状态机、Store 写入和端口参数；HTTP ingest smoke 锁定安全入口与 Viewer 可见性；E2E smoke 使用 fake Claude 命令验证 wrapper 环境、事件出口、最终刷新和清理。
