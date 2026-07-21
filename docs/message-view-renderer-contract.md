# Message View Model 与 Renderer 契约

Messages 视图拆成两个浏览器模块：

- `message-view-model.js` 把不同 role/content/block 形态规范为统一 DTO。
- `messages-renderer.js` 使用 DTO 输出原文/整理切换、role/type 标记、安全 Markdown 和结构化 Raw。

## View Model

- 标量消息规范为 `text` block。
- 数组 content 按原顺序保留 block；空数组得到显式 `empty` block。
- 文本优先读取 `text`、字符串 `content`、字符串 `input`；`tool_use` 可回退为工具名和调用 ID。
- Responses API 的动态 `tool_search_call` 使用协议名 `tool_search` 作为可读名称；对应 `tool_search_output.tools` 按命名空间与已发现工具名整理，不再把结构化搜索结果误判成空文本。
- 除 `type/text/content` 外仍有字段的 block 视为结构化 payload，整理视图保留可展开 Raw。
- Markdown 内联文本默认最多 5,000 字符，DTO 同时保留截断状态和原始长度。

## Renderer

- `source` 模式委托 Raw JSON renderer，不重解释消息。
- `organized` 模式显式显示 role、block type 和 block index。
- 文本通过受限 Markdown renderer；动态属性和文案通过 `escapeHtml`。
- 结构化 block 同时显示可读摘要与可展开 Raw，不丢失工具参数或结果字段。

## 验证

```bash
npm run smoke:message-view-renderer-contract
npm run smoke:markdown-safety
npm run smoke:viewer-static-assets-contract
```

真实浏览器 smoke 负责检查 Messages 原文/整理切换、Markdown 表格、长文本最大高度和结构化工具块展开。
