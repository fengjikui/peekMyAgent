# Viewer Trace Projector 契约

更新时间：2026-07-14

`ViewerTraceProjector` 是 Capture 证据与 Viewer Trace DTO 之间的单一应用投影边界。完整 Source 加载、单请求详情和 cursor 分页必须复用它提供的同一组语义端口，不能在 HTTP route、Source provider 或分页器中各自解释消息和回复。

## 模块边界

- `src/server/viewer-trace-projector.mjs` 接收普通对象并返回普通对象，不读取文件、SQLite、网络、DOM 或全局运行时状态。
- `src/viewer/server.mjs` 负责解析 source/request id、读取 captures、把 404 映射为 HTTP 错误并装配 Source 展示策略。
- `src/server/timeline-page-assembler.mjs` 拥有跨 cursor 页的增量状态，但它使用 Projector 提供的 capture、context、lineage、Turn、stats 和 workbench 端口。
- `src/trace/*` 继续拥有消息、协议、回复、Context Delta、Turn 和子 Agent 的领域语义；Projector 只组合这些契约。

## 输入与输出

完整投影的输入为：

```text
source + captures + optional debugSources + optional command + optional partial
```

输出保持现有 Viewer API 结构：

```text
generated_at
source + source.workbench
stats
requests[]
turns[]
agent_trace
optional partial
```

每个 request 同时包含来源画像、内容指纹、计数、当前输入、历史消息摘要、工具调用/结果、归一化 response、上下文构成和 compact raw。流式 `response.body_text`、与 `body_json` 重复的文本以及超过内联上限的大文本不会进入 compact DTO；完整详情仍由 SourceCaptureReader 按需读取。

## 三条调用路径

1. **完整/初始加载**：`buildData()` 统一生成 request、Turn、子 Agent 图、stats 和 workbench。
2. **单请求详情**：`projectRequestDetailWindow()` 同时投影目标请求和前一请求，随后计算相邻 Context Delta；找不到目标时返回 `null`，由 HTTP 层映射 404。
3. **cursor 分页**：`timelineAssemblerDependencies()` 把完全相同的 capture/context/lineage/Turn/stats/workbench 语义交给 `TimelinePageAssembler`，分页层只管理增量状态和 entity delta。

cursor 状态保存的是 compact request。`projectTimelineRequest()` 因此必须保持幂等：一个已经投影过的 request 再次进入轻量投影时，既不能重复包裹预览，也不能清零 `body_omitted`、`history_stack_omitted`、工具数量或其他省略元数据。直接契约会验证这一点。

## 可注入策略

Source 的项目名、捕获模式、捕获标签和 live 状态属于 Server/Source 展示策略，不属于 Trace 协议。Projector 通过 `sourceDisplay` 端口接收这些函数。时间通过 `now` 注入，使直接契约可以稳定验证 `generated_at`。

新增 Agent/provider 时：

- 协议正文解释应进入 `src/trace/` 或 adapter；
- Source 标题/状态策略应进入 Source provider；
- 不应在 Projector 中加入 provider 名称分支；
- 不应绕过 Projector 在 route 中手工拼 request DTO。

## 验证

```bash
npm run smoke:viewer-trace-projector-contract
npm run smoke:view-compact-detail
npm run smoke:timeline-cursor-http
npm run smoke:large-response-compact
```

直接契约在不启动 HTTP/SQLite 的情况下覆盖普通请求、工具结果回传、JSON/SSE response、compact raw、幂等轻量投影、Turn 归属、partial 总数、工作台摘要、详情窗口、标题推断、cursor assembler 端口以及完整/分页路径的结果等价性。
