# 请求/回复卡片 View 契约

更新时间：2026-07-14

`src/viewer/request-card-model.js` 是中栏单条请求卡的纯展示语义边界，负责把 Viewer request DTO 转成 renderer 可直接消费的 View DTO，包括：

- main/subagent/metadata/parent spawn 和 slash command 的标题、摘要与可见性；
- 用户输入、Harness 注入、`tool_use`、`tool_result` 和子 Agent 回流的样式类别、标签与预览；
- Harness 生命周期 semantic event 的紧凑机制摘要和证据限制；
- 上行快捷 section 列表；
- 当前 `tool_use` / `tool_result` 按 id 配对及孤立事件状态；
- Assistant response 的 usage、finish reason、Thinking 摘要、长文本折叠和工具调用 DTO。

`src/viewer/request-card-renderer.js` 负责中栏单条请求卡的稳定 HTML 结构，覆盖：

- request card 外壳和上行详情容器；
- 上行标题、摘要、owner 信息和快捷 Raw 动作；
- 当前 `tool_use` / `tool_result` 配对展示；
- Assistant response 的 metadata、Thinking、`tool_use`、Markdown 正文、折叠和 Raw 动作。

## 边界

Model 和 Renderer 都不读取 `state`、不访问 DOM、不发网络请求，也不注册翻译动作。Model 只通过显式依赖接收翻译、文本清理、截断、序列化和数字格式化函数；Renderer 只接收 View DTO、转义/Markdown renderer 和动作 HTML。

`client.js` 作为 application assembly 只负责：

- 决定上行详情是否打开、是否需要按需加载完整 request；
- 查找 Thinking 翻译、注册 action id，并提供加载状态；
- 把当前展开状态和格式化依赖交给 Model；
- 把 Model DTO、动作和预渲染受信任子块交给 Renderer。

请求分类、标签、预览、工具配对和 response metadata 不得在 `client.js` 中恢复第二份实现。Trace Domain 仍是协议和消息语义事实源；本 Model 只决定这些既有语义在请求卡上的呈现方式。

`upstreamEntryHtml`、`upstreamBodyHtml` 等参数是应用层已经生成的受信任子块。普通文本、属性值和 DTO 字段必须继续通过注入的 `escapeHtml`；Response Markdown 必须使用安全 Markdown renderer。

## 验证

`scripts/request-card-model-contract-smoke.mjs` 直接验证：

- 普通用户请求、slash command、metadata、Harness 注入和 subagent 的分类、标题、摘要与可见性；
- 上行快捷 section、工具调用/结果配对和孤立事件；
- Assistant usage、finish reason、Thinking、长回复与工具调用 View DTO；
- 未知 usage 字段和缺失 response 的保守退化。

`scripts/request-card-renderer-contract-smoke.mjs` 直接验证：

- request id、标题、摘要和工具参数转义；
- 上行展开状态、System/Tools/`tool_result` 与 Raw 动作；
- 工具按 id 配对、等待结果和孤立结果状态；
- Assistant metadata、Thinking 翻译、`tool_use`、长回复折叠和 Response Raw；
- 预渲染受信任子块可以组合进同一 request card。

`scripts/viewer-timeline-surface-contract-smoke.mjs` 继续约束依赖方向：`client.js` 必须使用请求卡 Model/Renderer，且不能重新定义分类、标签、预览、工具配对或 response metadata；Model/Renderer 不得访问 DOM、网络或全局状态。

真实浏览器回归仍需覆盖普通回复、带 `tool_use` 的回复、后续 `tool_result`、上行展开、Response Raw 和 Thinking 翻译按钮。纯 renderer 契约不替代这些交互验证。
