# 查看原始协议与调试异常

摘要视图适合快速理解，协议视图和 Raw Inspector 用于回答“原始字段究竟是什么”。当 adapter 分类、工具关联、上下文变化或模型参数看起来异常时，最终应回到这两层证据。

![按原生协议查看完整上下行](../../assets/demo/quickstart/06-protocol.png)

## 协议视图与 Raw 的区别

| 视图 | 适合解决什么问题 |
| --- | --- |
| 协议视图 | 按厂商原生语义顺序阅读 instructions/messages、tool call/result 和 response output |
| Raw Inspector | 检查 Capture headers、body、response、provenance、脱敏记录和任何未被摘要投影的字段 |

协议视图不是二次生成的对话稿。每个条目保留原始位置，例如 `$.input[4]`、`$.messages[2].content[1]`，并可以继续跳到 Raw。

## 当前可识别协议

Viewer 当前能解析并展示以下协议证据：

- OpenAI Responses；
- OpenAI Chat Completions；
- Anthropic Messages；
- Google GenerateContent。

“Viewer 能解析”不等于每个 Harness adapter 都能精确捕获所有协议，也不等于兼容服务完全遵循官方语义。实际能力取决于这条 Source 的 Capture transport、adapter 和响应完整度。

## OpenAI Responses 示例

经过脱敏的上行可以类似：

```json
{
  "model": "gpt-5.6",
  "instructions": "Use only public demo files.",
  "input": [
    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "读取 README" }] },
    { "type": "function_call", "call_id": "call_read", "name": "read_file", "arguments": "{\"path\":\"README.md\"}" },
    { "type": "function_call_output", "call_id": "call_read", "output": "# hello-agent" }
  ],
  "tools": [{ "type": "function", "name": "read_file" }],
  "reasoning": { "effort": "medium", "summary": "auto" },
  "stream": true
}
```

重点核对 `input` 顺序、call id、工具定义是否真的存在，以及 response 的完整终态事件是否被捕获。

## Anthropic Messages 示例

```json
{
  "model": "claude-sonnet-4-20250514",
  "system": [{ "type": "text", "text": "Use only public demo files." }],
  "messages": [
    { "role": "user", "content": "读取 README" },
    { "role": "assistant", "content": [{ "type": "tool_use", "id": "read_1", "name": "Read", "input": { "file_path": "README.md" } }] },
    { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "read_1", "content": "# hello-agent" }] }
  ],
  "tools": [{ "name": "Read", "input_schema": { "type": "object" } }]
}
```

Anthropic 的 tool result 通常位于后续 `user` message 的 content 中。不要因为摘要把它标为“工具结果”就误以为原始 role 是 `tool`。

## Raw Inspector 搜索

Raw 搜索适合定位：

- call id、tool use id 或 request id；
- 某个模型参数；
- System 中的特定短语；
- header 是否存在以及是否被脱敏；
- response error、finish reason 或 usage；
- 兼容层新增的未知字段。

搜索结果应在当前 Raw 区块内高亮和导航。切换 Source 或 Request 后要重新确认当前范围，避免把上一条 Source 的命中当作当前证据。

## 常见异常排查顺序

1. 时间线摘要是否缺失，还是 Capture 本身没有字段；
2. 协议视图是否能定位到原始 source path；
3. Raw body 是否完整、是否截断或按需加载；
4. response 是否有终态事件或完整 body；
5. provenance 是否说明 exact proxy、OTel、rollout 或导入证据；
6. adapter 的推断是否与 Raw 冲突。

Raw 与摘要冲突时以 Raw 和 provenance 为事实源，并把差异记录为产品反馈。

## 隐私提醒

Raw 可能包含完整 System、历史消息、工具 schema、路径、源码片段和模型回复。认证 header 会按规则脱敏，但这不代表整份 Raw 可以直接公开。分享前必须逐字段审查。
