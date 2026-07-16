# 上行详情 View 契约

更新时间：2026-07-14

上行详情回答“Agent 在这一轮真正发给模型的上下文由什么组成”。它分成两个无副作用模块：

- `src/viewer/upstream-detail-model.js`：把完整 request 规范成 System、Tools、历史消息栈、当前新增消息或子 Agent 回流、厂商 token 统计 View DTO。
- `src/viewer/upstream-detail-renderer.js`：根据显式 DTO 生成上行详情 HTML。

## 边界

两个模块都不得读取全局 `state`、访问 DOM 或发送网络请求。`client.js` 继续负责：

- 判断 compact request 是否需要按需读取完整详情；
- 从 request-detail cache 获取加载错误和完整 request；
- 读取上行展开状态，并决定 Timeline 的局部重绘时机；
- 注入安全 Markdown、文本清洗、i18n 和格式化函数。

Model 不建立新的 Trace 语义关系；历史消息、context delta、子 Agent 结果与 composition 必须来自 Capture/Trace Domain 已提供的证据。Renderer 不把 provider token 估算伪装为上下文字符统计，也不把下行 Response 字段混入上行结构。

## 稳定语义

- Tools 概览最多展示 18 个名称，并明确剩余数量。
- 历史消息保留 role、上下文状态、命令、`tool_use` 和 `tool_result` 证据。
- 普通请求显示 context delta 的新增消息；子 Agent 回流显示受限 Markdown 结果块。
- OpenAI-compatible `prompt_tokens` 已包含 cached tokens；Anthropic-compatible `input_tokens` 与 `cache_read_input_tokens` 分开累计。
- 所有普通文本必须转义；子 Agent Markdown 必须使用受限 Markdown renderer。

`scripts/upstream-detail-view-contract-smoke.mjs` 直接锁定 DTO、两类 token 口径、Tools 截断、历史消息、子 Agent 回流、HTML 转义和无副作用边界。
