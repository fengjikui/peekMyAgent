# Viewer API DTO 契约

更新时间：2026-07-15

Viewer HTTP 的 pathname、method、lookup 上限和首屏分页参数，以及首批跨 Server/Client 的响应 DTO，统一由 `src/contracts/viewer-api.mjs` 定义。该模块必须保持浏览器和 Node.js 双端可执行，不能依赖 DOM、文件系统或 Node-only API。

## 版本

- `VIEWER_API_DTO_CONTRACT_VERSION = 1`
- `SOURCE_SUMMARY_CONTRACT_VERSION = 1`
- `TRACE_REQUEST_DETAIL_CONTRACT_VERSION = 1`
- `TRACE_TIMELINE_RESPONSE_CONTRACT_VERSION = 1`

当前版本常量用于代码和测试声明兼容边界，尚未写入每个 JSON payload。需要不兼容调整时，必须先设计兼容读取或显式 API 版本，而不是静默改变字段含义。

## SourceSummary

`GET /api/sources` 返回 `SourceSummary[]`。每个元素至少包含：

| 字段 | 契约 |
| --- | --- |
| `id` | 非空字符串，Source 的稳定选择键 |
| `label` | 非空字符串，用户可见标题 |
| `kind` | 非空字符串，Source provider 类型 |
| `available` | 布尔值，当前是否可读取 |
| `request_count` | 可选的非负数 |

Provider 结果在 `SourceRepository` 汇聚后验证；浏览器 `ViewerApiClient.listSources()` 在 JSON 解析后再次执行相同契约。错误不会继续传播到 Session Navigator。

## TraceRequestDetail

`GET /api/request` 返回单请求窗口：

```text
{
  generated_at: non-empty string,
  source: SourceSummary,
  request: {
    id: non-empty string,
    request_index: positive integer,
    detail_scope: "request_window",
    ...projected request fields
  },
  detail_scope: "request_window"
}
```

`ViewerTraceProjector` 负责构造请求，Viewer Server 在序列化前验证，`ViewerApiClient.requestDetail()` 在浏览器边界再次验证。契约只约束跨层身份和水合范围，不重复定义 request 内部的 Trace/Response/Raw 语义。

## TraceTimelineResponse

`GET /api/view` 的完整、compact 与 cursor 响应共用一个 envelope 契约：

- 所有响应都必须包含合法 `SourceSummary`、`generated_at`、`stats` 和带稳定 `id`/正整数 `request_index` 的 `requests`；
- 完整与 compact snapshot 必须携带 `turns` 和完整 `agent_trace` 基线；
- cursor 页面以 `page_scope: "timeline_cursor_delta"` 区分，必须携带 request/Turn patch 集合和 `partial.mode: "cursor"`；
- cursor 首屏可以同时携带完整 `turns`/`agent_trace`，后续页只携带 `turn_updates` 与 `agent_trace_delta`；
- `partial` 约束加载数量、总数、页偏移、页内数量、是否仍有下一页以及 opaque cursor 的可空关系。

契约有意不重复定义 request、Turn、branch、spawn 和 return 的完整领域 schema。这些实体继续由 Trace Domain、`ViewerTraceProjector` 与 `TimelineEntityStore` 拥有；共享层只固定跨 HTTP 边界的身份、信封和分页不变量。`ViewerRouter` 在序列化前验证最终表示，`ViewerApiClient.viewSource()` 在浏览器 JSON 解析后再次验证。

## 尚未纳入

- translation、watch control、Agent send 和 import/export 的响应 DTO。

这些接口仍由各自 Service/Controller 契约约束。后续迁移必须逐条接入共享模块，不能为了“一次完成”而建立宽松的万能 schema。

## 验证

```bash
npm run smoke:viewer-api-dto-contract
npm run smoke:source-repository-contract
npm run smoke:viewer-api-client-contract
npm run smoke:viewer-http-contract
npm run smoke:timeline-cursor-http
npm run smoke:trace-bundle
npm run smoke:viewer-static-assets-contract
```

`viewer-api-dto-contract` 覆盖版本、snapshot/cursor/detail 合法 DTO 和错误路径；Client 契约证明畸形 JSON 会在 API 边界被拒绝；HTTP、cursor 与 Trace bundle smoke 证明真实 Server 投影满足契约。
