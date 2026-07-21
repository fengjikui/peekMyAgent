# 模型回复归一化契约

更新时间：2026-07-21

`src/trace/model-response-normalizer.mjs` 把捕获层保存的 JSON 或 SSE 模型回复转换成 Viewer 与 Trace Domain 共用的下行 DTO。它属于协议归一化边界，不属于 HTTP Server，也不负责页面渲染；content/tool block 基础解析复用 [Trace Content Parts 契约](content-parts-contract.md)。

## 所有权

该模块负责：

- 从 Anthropic/OpenAI-compatible content 中区分可见文本、thinking/reasoning 与 `tool_use`；
- 解析非流式 Anthropic message、OpenAI Chat Completions 风格 `choices` 和兼容 `output`；
- 重组 Anthropic SSE 的 text/thinking/input JSON delta；
- 重组 OpenAI-compatible SSE 中按 index 分片的 function tool call，以及 `tool_search_call` 等 Responses API 动态 `*_call` 下行条目；
- 输出稳定的 response summary 和 `complete_response`。

该模块不负责：

- 捕获、转发或持久化原始响应；
- 推断 provider、Agent、Turn 或子 Agent 归属；
- 截断 Viewer Raw body 或生成 HTML；
- 访问网络、文件、环境变量或应用全局状态。

## 输入

`summarizeModelResponse(response)` 接收捕获层 response record：

```text
{
  headers,
  body_json,
  body_text,
  duration_ms,
  status,
  truncated,
  raw_body_length,
  captured_body_length,
  received_at
}
```

`content-type: text/event-stream` 或以 `event:` / `data:` 起始的正文会进入 SSE 路径，其余进入 JSON 路径。无法解析的 SSE event 被忽略，但仍计入 `event_count`，避免单个异常 chunk 破坏整条回复。

## 输出

统一 summary 主要字段：

```text
captured
message_id
text / preview
thinking / thinking_preview
tool_calls[]
usage
finish_reason
complete_response
latency_ms / status
stream / event_count / truncated
raw_body_bytes / captured_body_bytes / received_at
```

`complete_response.content` 始终按 thinking、text、tool_use 的顺序组装；`tool_calls[].arguments` 与 `complete_response.content[].input` 使用解析后的同一值。流式 function arguments 无法形成 JSON 时保留原字符串，不伪造结构。

Responses API 中所有已捕获的 `*_call` output item 都按模型下行工具调用归一化；有显式 `name` 时保留原名，否则从协议类型派生可读名称，例如 `tool_search_call` 映射为 `tool_search`。对应的 `tool_search_output` 属于下一次请求的上行工具结果，由共享 request payload 语义处理，不混入当前 response。

## 兼容事实

- `extractContentText()` 会排除 thinking/reasoning 块。
- 其他结构化 content 块沿用既有兼容行为，以 JSON 文本进入可见 text；因此 Anthropic `tool_use` 既能出现在结构化 `tool_calls`，也可能出现在 response text。调整这一点属于单独的产品行为变更，不能在重构中静默修改。
- 重复 tool call 以 `id + name + stable arguments` 去重。
- 没有 response 时返回 `captured: false` 的固定空 DTO，不生成 `complete_response`。

## 扩展协议

接入新的模型协议时，应先在本模块增加最小 fixture 和归一化分支，再让 Server/Viewer 消费统一 DTO。不得把新 provider 的 SSE/JSON 字段判断重新写进 `server.mjs`、renderer 或 adapter 展示代码。

## 验证

直接契约测试：

```bash
npm run smoke:model-response-normalizer-contract
```

它覆盖 Anthropic JSON、Anthropic SSE、OpenAI-compatible JSON/SSE、thinking、分片工具参数、损坏 SSE、空 response 和依赖方向。`npm run smoke:response-capture` 继续用真实本地 HTTP 流程验证 Capture Proxy、SQLite 重启与 Viewer DTO 的端到端兼容。
