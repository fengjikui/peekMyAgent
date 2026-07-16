# Viewer Source Capture Reader 契约

更新时间：2026-07-15

`src/server/source-capture-reader.mjs` 统一 live watch、SQLite persisted capture 和 file/imported Trace 的证据读取接口。它只负责读取窗口，不解释 turn、tool exchange 或子 Agent 语义。

## 读取模式

- `read(source, { limit })`：Viewer 首屏或完整视图读取；返回 captures、debug companion、command、totalCount 和 startIndex。
- `readPage(source, { cursor, limit })`：按 reader offset 读取一个有界 capture 页面；内部 `next_cursor` 只交给 `TimelineCursorService`，不会直接暴露给浏览器。
- `readRequestWindow(source, requestId, { previousCount })`：读取目标请求及其前置上下文窗口；默认包含前一条，供 context delta 计算。
- `readAll(source)`：Trace export 快速路径；只读取 captures，不读取 debug/command companion，也不构建 Viewer timeline。

统一返回结构：

```text
{
  captures,
  debugSources,
  command,
  totalCount,
  startIndex
}
```

分页结果在上述字段外增加：

```text
page: {
  cursor,
  next_cursor,
  offset,
  limit,
  loaded_count,
  total_count,
  has_more
}
```

## Backend 行为

- live：从当前 watch 的共享/独立 proxy capture 集合读取，command 由 runtime 端口提供。
- persisted：首屏使用 `loadInitialCaptures`，分页使用 SQLite `loadCapturePage`，单请求使用 `loadCaptureWindow`，全量只在明确请求时使用 `loadCaptures`。这些 `PersistenceStore` facade 由 [`SqliteCaptureReadRepository`](sqlite-capture-read-repository-contract.md) 实现，reader 不直接持有 SQLite 查询或水合逻辑。
- file/imported：有界首屏、分页与请求窗口通过私有 JSON array sidecar 读取对象 byte range；完整导出才 parse 全部 `proxy-captures.json`。debug companion 使用同一索引，command 只在需要的 Viewer 读取模式加载。

## 性能与兼容约束

- 单请求详情不得退化为 SQLite `loadCaptures()` 全表读取。
- SQLite 分页不得 hydrate 页外 content blob 或 response blob。
- reader cursor 是非负 offset，页面最大 100；HTTP 层必须使用独立的不透明 cursor，不能泄露该 offset。
- Trace export 不得读取 debug/command companion 或构建完整 timeline。
- `request_index` 存在时优先用它恢复窗口原始位置；文件窗口的 debug companion 必须按同一 startIndex 切片。
- reader 不改变 CaptureRecord，不补写 provenance，也不持久化数据。
- file index 只属于读取后端，原始 Trace 保持只读；sidecar 位置、指纹、失效和 deep-link 回退见 [JSON Array File Index 契约](json-array-file-index-contract.md)。

## 后续演进

当前 reader 的 live、SQLite、file/imported backend 都支持有界页面。后续仍可在不改变 Viewer route 和 Trace domain 的前提下增加可取消文件读取、持久化 request identity 和 page eviction。HTTP 与语义增量协议见 [Timeline Cursor 分页契约](timeline-pagination-contract.md)。
