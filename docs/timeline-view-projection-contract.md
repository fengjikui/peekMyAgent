# Timeline 轻量投影契约

更新时间：2026-07-14

本文记录 `/api/view?compact=1` 使用的轻量时间线 DTO 边界。它不是 Trace 语义模型，也不是持久化格式；完整请求仍通过 `/api/request` 按需读取。

## 所有权

`src/server/timeline-view-projector.mjs` 只负责把完整 Viewer Trace DTO 投影成首屏和时间线所需的轻量 DTO：

- 保留请求、Turn、Source 和统计的既有结构；
- 截断用户输入、System/Assistant 预览、Thinking、子 Agent 结果和工具参数；
- 删除历史消息正文、完整 Response、Raw headers、Raw body 和 response body；
- 用 `*_omitted`、`detail_omitted` 和数量字段明确说明被省略的内容；
- 保留 `/api/request` 恢复完整详情所需的 request id。

它不得读取文件、SQLite、HTTP request、watch runtime 或浏览器状态，也不得修改输入 DTO。Trace 语义解释仍属于 `src/trace/`，Source 读取仍属于 repository/reader。

## 数据边界

- `projectTimelineViewerData(data)`：保留顶层 Viewer DTO，只投影 `requests`。
- `projectTimelineRequest(request)`：可直接测试的单请求投影。
- `TIMELINE_VIEW_LIMITS`：集中记录所有时间线正文、数组和预览上限。
- `raw.body` 只保留模型采样元数据；消息、System 和 Tools 只保留数量与原始长度。
- `raw.response` 只保留状态、时间、大小和截断元数据；完整 JSON/SSE 内容不进入 compact payload。
- `summary.composition` 只保留上行构成栏目，不把 Response 诊断字段带入轻量时间线。

`compact=0` 或省略 `compact` 的旧完整 Viewer API 保持兼容。轻量 DTO 不能被持久化或当作完整 Trace 重新导出。

投影与分页是两个独立边界：projector 决定“单个 compact request 保留哪些字段”，cursor/assembler 决定“当前 HTTP 页面发送哪些 request 和实体变化”。分页协议见 [Timeline Cursor 分页契约](timeline-pagination-contract.md)。

## 验证

直接契约：

```bash
npm run smoke:timeline-view-projector-contract
npm run smoke:timeline-page-merge-contract
npm run smoke:timeline-cursor-service-contract
npm run smoke:timeline-cursor-http
```

HTTP、完整详情恢复和大 Trace 性能：

```bash
npm run smoke:view-compact-detail
npm run smoke:large-response-compact
npm run smoke:compact-view-performance
```
