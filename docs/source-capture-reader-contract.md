# Viewer Source Capture Reader 契约

更新时间：2026-07-12

`src/server/source-capture-reader.mjs` 统一 live watch、SQLite persisted capture 和 file/imported Trace 的证据读取接口。它只负责读取窗口，不解释 turn、tool exchange 或子 Agent 语义。

## 读取模式

- `read(source, { limit })`：Viewer 首屏或完整视图读取；返回 captures、debug companion、command、totalCount 和 startIndex。
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

## Backend 行为

- live：从当前 watch 的共享/独立 proxy capture 集合读取，command 由 runtime 端口提供。
- persisted：首屏使用 `loadInitialCaptures`，单请求使用 `loadCaptureWindow`，全量只在明确请求时使用 `loadCaptures`。
- file/imported：目前仍需 parse 完整 `proxy-captures.json` 后切片；debug 与 command 文件只在 Viewer 读取模式加载。

## 性能与兼容约束

- 单请求详情不得退化为 SQLite `loadCaptures()` 全表读取。
- Trace export 不得读取 debug/command companion 或构建完整 timeline。
- `request_index` 存在时优先用它恢复窗口原始位置；文件窗口的 debug companion 必须按同一 startIndex 切片。
- reader 不改变 CaptureRecord，不补写 provenance，也不持久化数据。

## 后续演进

当前 reader 统一了调用协议，但 file/imported backend 仍是完整 JSON parse。后续可以在不改变 Viewer route 和 Trace domain 的前提下替换为 sidecar index、cursor/turn 分页和可取消读取。
