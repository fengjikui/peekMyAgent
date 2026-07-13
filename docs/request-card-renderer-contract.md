# 请求/回复卡片 Renderer 契约

更新时间：2026-07-13

`src/viewer/request-card-renderer.js` 负责中栏单条请求卡的稳定 HTML 结构，覆盖：

- request card 外壳和上行详情容器；
- 上行标题、摘要、owner 信息和快捷 Raw 动作；
- 当前 `tool_use` / `tool_result` 配对展示；
- Assistant response 的 metadata、Thinking、`tool_use`、Markdown 正文、折叠和 Raw 动作。

## 边界

Renderer 不读取 `state`、不访问 DOM、不发网络请求，也不注册翻译动作。`client.js` 在调用前负责：

- 判断请求属于用户输入、内部请求、工具回传或子 Agent；
- 决定上行详情是否打开、是否需要按需加载完整 request；
- 配对工具事件并整理 response metadata；
- 查找 Thinking 翻译、注册 action id，并提供加载状态；
- 决定长回复的折叠状态和可见文本。

`upstreamEntryHtml`、`upstreamBodyHtml` 等参数是应用层已经生成的受信任子块。普通文本、属性值和 DTO 字段必须继续通过注入的 `escapeHtml`；Response Markdown 必须使用安全 Markdown renderer。

## 验证

`scripts/request-card-renderer-contract-smoke.mjs` 直接验证：

- request id、标题、摘要和工具参数转义；
- 上行展开状态、System/Tools/`tool_result` 与 Raw 动作；
- 工具按 id 配对、等待结果和孤立结果状态；
- Assistant metadata、Thinking 翻译、`tool_use`、长回复折叠和 Response Raw；
- 预渲染受信任子块可以组合进同一 request card。

真实浏览器回归仍需覆盖普通回复、带 `tool_use` 的回复、后续 `tool_result`、上行展开、Response Raw 和 Thinking 翻译按钮。纯 renderer 契约不替代这些交互验证。
