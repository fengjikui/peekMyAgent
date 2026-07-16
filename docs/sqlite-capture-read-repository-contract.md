# SQLite Capture Read Repository 契约

更新时间：2026-07-15

`src/persistence/repositories/sqlite-capture-read-repository.mjs` 是 SQLite Capture 读取路径的唯一实现边界。它接收一个已经打开并完成 migration 的数据库连接，负责按 watch/query window 读取 CaptureRecord，并按需水合 request body 与 response body。

`PersistenceStore` 继续保留原有同名公共方法作为兼容 facade。Server 和 `SourceCaptureReader` 不直接依赖具体 repository，因此本次拆分不改变 API、Source 协议或持久化格式。

## 拥有的行为

- `loadCaptures(watchId)`：按 `request_index, received_at` 读取完整 watch。
- `loadInitialCaptures(watchId, { limit })`：读取最多 50 条首屏 Capture。
- `loadCapturePage(watchId, { offset, limit })`：读取非负 offset、最多 100 条的有界页面。
- `loadCaptureWindow(watchId, requestId, { previousCount })`：读取目标 Capture 及其前置窗口。
- `findCaptureRow` / `previousCaptureRows`：执行 request identity 定位和前序行查询。
- `captureFromRow`：恢复 CaptureRecord 的持久化字段并选择 body 来源。
- `reconstructBody`：从 ordered request tree 与 content blobs 重建 request body。
- `hydrateResponse`：从 content-addressed response blob 恢复 `response.body_text`。

## 不拥有的行为

Repository 不得：

- 创建、迁移、关闭或 `VACUUM` 数据库；
- 执行 DDL、写事务、Capture/Watch upsert、删除或 blob GC；
- 改变 schema version、Source DTO、Trace domain 语义或 Viewer 投影；
- 缓存跨调用的可变 CaptureRecord。

连接生命周期、migration、WAL 和文件权限仍由 `PersistenceStore` 所有；写入与维护路径也暂时保留在那里。

## 读取不变量

1. 有原始 `raw_body_json` 时优先使用原始 body；否则只为当前行读取 request tree 和 content blobs。
2. 有 `response.body_ref` 且没有内联 `body_text` 时才读取 response blob。
3. 页面读取不得水合页外 Capture。页外 blob 缺失不能让当前有效页面失败。
4. 数字形式的 request id 同时可能命中 `request_id` 与 `request_index`；精确 `request_id` 必须优先。
5. 窗口返回顺序必须是“较早 Capture 到目标 Capture”，而不是数据库查询使用的倒序。
6. 找不到窗口目标时 repository 返回空数组，由上层 reader 转成协议级 not-found。
7. 缺失当前 Capture 必需的 request tree/blob 时明确失败，不静默返回不完整 body。

## 验证

直接契约：

```bash
npm run smoke:sqlite-capture-read-repository
```

兼容与集成：

```bash
npm run smoke:persistence-store
npm run smoke:source-capture-reader
npm run smoke:response-capture
```

该模块属于持久化高平台风险边界，推送、交接或发布前仍需运行当前主机的完整 release profile。
