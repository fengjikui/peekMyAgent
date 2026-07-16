# Trace 请求构成契约

更新时间：2026-07-14

`src/trace/request-composition.mjs` 把已归一化的请求 body、System blocks、Tools、Messages、当前用户消息和模型回复摘要解释为稳定的字符规模诊断 DTO。它回答“这条请求主要由哪些上下文部分构成”，不负责 tokenizer 计费、上下文差分或页面渲染。

## 所有权

该模块负责：

- 统计 System、Tools schema、其他顶层参数与 Messages 的字符规模；
- 区分当前用户、历史用户、Assistant 历史、tool use、tool result 与 Harness/Agent 内部消息；
- 提供固定上下文、历史上下文和各分区相对请求总量的比例；
- 记录当前模型回复 text/thinking 的规模，供完整 Trace 诊断使用。

该模块不负责：

- 捕获、持久化、压缩或修改请求；
- 判断 main/subagent、建立 Turn、Context Delta 或子 Agent 血缘；
- 把字符数宣称为 provider token 数或计费 token；
- 决定 Raw Inspector 是否展示上行或下行字段；
- 生成 HTML、颜色、图表或其他 Viewer 表现。

## 统计口径

- `unit` 当前固定为 `chars`，属于快速诊断近似值，不是 tokenizer 精算。
- `total_payload_chars` 优先沿用 Capture 已记录的 `raw_body_length`，缺失时才使用 JSON 字符长度。为了兼容现有 Trace DTO，该字段名暂不变更；调用方不能将其当作 provider token 证据。
- System 使用各 block 的文本长度；Tools 与其他参数使用 JSON 长度。
- tool use 使用已归一化 tool call 的稳定 JSON；tool result 使用可见文本。
- `current_user`、`history_context` 等分区存在包含关系，不能把所有 section 简单相加后期待等于 total。
- Response text/thinking 是同一条 Capture 的下行诊断字段；上行 Raw 视图继续通过 `raw-view-model.js` 排除这些字段。

消息类别复用 `message-semantics.mjs` 的 `classifyMessageKind()`，确保 slash command、compact、Skill、framework reminder、suggestion、tool result 和混合消息不会在 Server 与构成统计中产生两套含义。

## 验证

```bash
npm run smoke:request-composition-contract
```

直接契约覆盖全部分区、比例、Capture 总量优先级、JSON fallback、消息类别守恒、混合用户/tool-use 优先级和 Trace Domain 依赖方向。`smoke:suggestion-mode`、`smoke:tool-exchange-delta`、Raw View Model 与真实 Viewer smoke 继续验证 Server 装配和呈现兼容。
