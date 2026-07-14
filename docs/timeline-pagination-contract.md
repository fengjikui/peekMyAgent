# Timeline Cursor 分页契约

更新时间：2026-07-14

本文记录大 Trace 在 Viewer 首屏、后台续读和 live 增量刷新中的分页协议。它是 HTTP/Server/Client 之间的运行时契约，不是持久化格式；完整请求仍通过 `/api/request` 按需读取。

## 目标与边界

当 Source 达到渐进加载门限时，浏览器不再在首屏之后请求整条 compact Trace。数据路径改为：

```text
SourceCaptureReader.readPage
  -> TimelineCursorService
  -> TimelinePageAssembler
  -> compact request / annotation / Turn / Agent entity delta
  -> TimelineEntityStore
  -> Viewer timeline window
```

分页必须同时保持以下语义：

- Context Delta 按相同 context chain 的上一条请求比较，而不是按页面或全局上一行比较。
- 子 Agent 可以匹配更早页面中的父级 `Agent`/`Task` tool use。
- 跨页的内部请求可以在后续用户边界出现后修正 Turn 归属。
- 后续页不重复返回已经加载的请求、完整 Turn 前缀或完整 Agent 图。
- Raw body、完整 Response、System 和 Tools 正文继续由 `/api/request` 懒读取，不进入 compact 页面。

## HTTP 协议

开始一次读取：

```http
GET /api/view?source=<source>&compact=1&initial=1&limit=32
```

继续读取：

```http
GET /api/view?source=<source>&compact=1&cursor=<opaque-token>&limit=100
```

`cursor` 是 daemon 内存中的不透明 token，不是 SQLite offset、request index 或可跨进程保存的标识。token 绑定 Source，默认 15 分钟过期；不存在或过期返回 `410`，用于其他 Source 返回 `409`。客户端遇到失效 token 时应从首屏重新构建 compact 时间线，而不能猜测 reader offset。

`limit` 必须为正整数，Server 最大接受 100。Client 首屏使用 32，后续页使用 100。

## 页面结构

每页都包含当前页新增的 compact `requests`、可能修正旧请求归属的 `request_patches`、当前统计、Source 摘要和 `partial`：

```json
{
  "page_scope": "timeline_cursor_delta",
  "requests": [],
  "request_patches": [],
  "turn_updates": [],
  "removed_turn_ids": [],
  "agent_trace_delta": null,
  "partial": {
    "mode": "cursor",
    "loaded_request_count": 32,
    "total_request_count": 1536,
    "page_offset": 0,
    "page_request_count": 32,
    "has_more": true,
    "next_cursor": "opaque-token",
    "refresh_cursor": "opaque-token"
  }
}
```

首屏额外返回当前完整 `turns` 和 `agent_trace` 基线。后续页只返回：

- `turn_updates`：新增或发生变化的完整 Turn 实体；
- `removed_turn_ids`：需要从 Client entity map 删除的 Turn；
- `agent_trace_delta`：branch/spawn/return 的更新和删除集合，以及最新图统计；
- `request_patches`：旧请求最新的 `turn_id`、完整 `trace` annotation 和子 Agent 来源字段。

`request_patches.trace` 是原子替换字段，不是浅合并补丁。这样在重新编组后，已经失效的 `branch_id`、`spawn_branch_ids` 或 `returned_branch_ids` 不会残留。

Client 的 `TimelineEntityStore` 以 request/Turn/branch/spawn/return 的稳定 id 持有 normalized map，并只在界面需要时物化兼容数组快照。页面级 delta 字段不进入长期应用状态；完整 request detail 会覆盖证据字段，但不能反向覆盖 cursor 已确认的 Turn、Context 和 Agent 归属。

## Live 续读

读取到当前尾部后：

- `has_more=false`；
- `next_cursor=null`；
- live Source 仍保留 `refresh_cursor`；
- stored/file Source 释放 Server session，`refresh_cursor=null`。

live Source 出现新 capture 后，Client 用 `refresh_cursor` 只读取新增页面。若没有新增 capture，Server 返回空 requests/no-op delta 并继续保留 token。Source rename/archive/delete 会清理对应 cursor session；Client 在 token 失效时回退到一次新的首屏读取。

## Server 状态

一个 cursor session 只保留 compact 时间线需要的状态：

- 已加载的 compact request DTO；
- 每个 context chain 最新请求；
- 已知父级 Agent spawn prompt；
- request、Turn 和 Agent entity snapshot；
- reader cursor、Source 和最近一次 payload。

它不保留完整 Raw request/response body。daemon 默认最多保留 8 个 session，并按 TTL/最久未使用顺序清理，避免浏览器切换 Source 后无限增长。

## 当前限制

- SQLite 和 live backend 真正只 hydrate 当前页；file/import backend 目前仍需读取并 parse 完整 `proxy-captures.json` 后切片，后续由 sidecar index 解决。
- Server 为保证跨页 Turn 与多 Agent 语义，目前保留已加载 compact prefix 并重建派生实体；网络已经是实体增量，但 CPU 仍有进一步增量化空间。
- Client 已使用 normalized entity store 避免每页从完整数组重建实体 map，但仍会为兼容现有 View Model 物化完整 compact 数组快照，并在后台页到达时重绘 timeline window；page eviction、细粒度订阅和只物化可见实体仍是后续阶段。

## 验证

```bash
npm run smoke:source-capture-reader
npm run smoke:context-delta-contract
npm run smoke:subagent-graph-contract
npm run smoke:timeline-cursor-service-contract
npm run smoke:timeline-entity-store-contract
npm run smoke:timeline-cursor-http
npm run smoke:compact-view-performance
npm run smoke:view-compact-detail
```

`compact-view-performance` 同时约束首屏大小、完整 compact 兼容路径、页面覆盖完整性以及累计分页传输保持线性。
