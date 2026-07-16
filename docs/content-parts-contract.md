# Trace Content Parts 契约

更新时间：2026-07-14

`src/trace/content-parts.mjs` 是上行请求和模型下行共同使用的最小协议原语层。它只解释 message/content block，不判断 Turn、Agent、provider 或页面展示。

## 所有权

该模块负责：

- 从 string、text block 和嵌套 content 中提取可见文本；
- 将 thinking/reasoning 与可见文本分离；
- 统一 Anthropic `tool_use` 与 OpenAI-compatible `tool_calls`；
- 统一 role=`tool` 与 Anthropic `tool_result`；
- 尝试把字符串工具参数解析为 JSON，解析失败时保留原字符串。

该模块不负责：

- 判断消息是用户输入、Harness 注入、命令或子 Agent 回流；
- 组装完整 response、usage 或 stop reason；
- 推断 provider、关联上下文或生成 Viewer HTML；
- 访问网络、文件、环境变量或应用状态。

## 兼容事实

- thinking/reasoning 块不会进入 `extractContentText()`。
- 未识别的结构化 content block 沿用既有行为，以 JSON 字符串保留，避免静默丢证据。
- OpenAI-compatible function arguments 是合法 JSON 时返回结构化值，否则保留原字符串。
- 一个 Anthropic user message 可以同时包含 `tool_result` 与后续 Harness text；工具结果提取只返回 `tool_result` 部分。

## 依赖方向

`model-response-normalizer` 和后续 message semantics 可以依赖本模块；本模块不得依赖 Server、Viewer、provider adapter 或持久化层。新增协议块时先在这里增加最小 fixture，避免在上行与下行路径各写一份解析。

## 验证

```bash
npm run smoke:content-parts-contract
```
