# OpenAI / Anthropic 协议 Schema 覆盖与用户信息模型

更新时间：2026-07-27

本文定义 peekMyAgent 如何跟踪 OpenAI Responses、OpenAI Chat Completions 和 Anthropic Messages 的官方协议。它既不是厂商 API 文档的镜像，也不是 Harness Adapter 规则集合；它回答三个问题：官方协议有多大、哪些字段直接解释 Harness 运行机制、PMA 对每类信息承诺什么覆盖等级。

当前官方事实源：

- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)、[Using tools](https://developers.openai.com/api/docs/guides/tools)、[Tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)；
- [OpenAI 官方 TypeScript SDK Responses 类型](https://github.com/openai/openai-node/blob/master/src/resources/responses/responses.ts)与 [Chat Completions 类型](https://github.com/openai/openai-node/blob/master/src/resources/chat/completions/completions.ts)；
- [Anthropic Messages API](https://platform.claude.com/docs/en/api/go/messages/create)、[Tool reference](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference)、[Tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)；
- [Anthropic 官方 TypeScript SDK Messages 类型](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts)。

这些协议会继续演进。更新本文时必须重新检查官方来源和实际 SDK union，不能把本文中的数量长期当作固定标准。

## 目标用户要回答的问题

PMA 的核心用户在研究 Coding Agent Harness 的内部机制，而不是只调试一次普通聊天。他们通常关心：

1. **模型究竟看到了什么**：System/Developer 指令、用户输入、历史回复、工具结果、文件和图片分别位于哪里，优先级是什么。
2. **上下文如何演进**：历史是完整重发、通过 response/conversation id 延续，还是发生了压缩、裁剪、引用、缓存断点或中途 System 更新。
3. **工具何时可用**：哪些工具一开始声明，哪些延迟加载，namespace/MCP 中有哪些叶子，tool search 后具体加载了什么。
4. **工具循环如何运行**：模型选择了哪个工具、参数和 call id 是什么、由客户端还是厂商服务器执行、结果/错误怎样回到模型、是否发生审批或并行调用。
5. **Harness 做了哪些编排**：是否有后台请求、标题生成、压缩、子 Agent、Skill、Memory 或 framework reminder。协议层只提供事实，Harness 层依据 provenance 和强证据归因。
6. **模型为什么这样回复或停止**：reasoning/thinking、结构化输出约束、拒绝、截断、暂停、失败和 stop reason。
7. **运行代价与数据边界**：token/cache usage、远程 MCP/server tool、文件/图片/audio、持久化、后台执行和安全检查。
8. **协议是否发生漂移**：出现了哪些 PMA 尚未认识的正式类型；未知类型必须保留路径并进入覆盖统计，而不是静默降级成普通消息。

其中 1–6 是 P0 机制信息；7 是 P1 诊断与隐私信息；temperature、top_p、seed 等生成参数属于 P2 配置事实，保留在 Raw/Metadata 即可，不占用主协议时间线。

## 三层覆盖策略

| 层级 | 承诺 | 实现边界 |
| --- | --- | --- |
| Raw 全量保真 | 捕获范围内的请求、响应和 SSE 原始字段不因 PMA 未识别而丢失 | Raw Inspector、原始响应与 provenance |
| Schema 全量识别 | 对官方 union 中的顶层字段、item/content block、tool 和 stream event 建立清单；未知正式类型可被发现和计数 | 本文、contract fixtures、后续漂移检查 |
| 机制语义解析 | 对影响 Harness 上下文、工具生命周期、执行、推理、终态和资源边界的类型给出稳定语义与 Raw JSONPath | `protocol-exchange.mjs`、`content-parts.mjs`、`model-response-normalizer.mjs` |

不采用“给厂商 Schema 的每个叶子字段制作专用 UI”的方案。Responses 官方 SDK 单文件约 9,400 行，Chat Completions 约 2,700 行，Anthropic Messages 约 3,800 行；其中包含大量模型配置、版本化工具参数和结果内部结构。把它们全部复制到 PMA 会形成第二套易漂移 Schema，而不会提高 Harness 可解释性。

完整性的定义因此是：**Raw 不丢、正式类型可识别、P0/P1 机制字段有语义、P2 字段可从 Metadata/Raw 查到。**

## OpenAI Responses

### 顶层请求

当前官方 `ResponseCreateParamsBase` 有约 30 个字段，按用户问题分组如下：

| 类别 | 字段 | PMA 优先级 |
| --- | --- | --- |
| 模型与连续性 | `model`、`conversation`、`previous_response_id` | P0 |
| 上下文与指令 | `instructions`、`input`、`prompt`、`context_management`、`truncation` | P0 |
| 工具编排 | `tools`、`tool_choice`、`parallel_tool_calls` | P0 |
| 推理与输出 | `reasoning`、`text`、`max_output_tokens`、`include`、`top_logprobs` | P0/P1 |
| 执行生命周期 | `stream`、`stream_options`、`background`、`store`、`service_tier` | P1 |
| 缓存、安全和归属 | `prompt_cache_key`、`prompt_cache_options`、`prompt_cache_retention`、`safety_identifier`、`moderation`、`metadata`、`user` | P1；敏感值只在 Raw 中查看 |
| 生成参数 | `temperature`、`top_p` | P2 |

### `input[]` 正式条目

当前 `ResponseInputItem` union 有 32 个成员；三种 message interface 共享 `type=message`，因此共有 30 个不同的顶层 `type` 标签：

| 机制类别 | 原生 `type` |
| --- | --- |
| 消息/历史 | `message` |
| 推理 | `reasoning` |
| 工具发现与增量 | `additional_tools`、`tool_search_call`、`tool_search_output`、`mcp_list_tools` |
| 普通与自定义调用 | `function_call`、`custom_tool_call` |
| 内置调用 | `file_search_call`、`web_search_call`、`computer_call`、`image_generation_call`、`code_interpreter_call`、`local_shell_call`、`shell_call`、`apply_patch_call`、`mcp_call` |
| 工具结果 | `function_call_output`、`custom_tool_call_output`、`computer_call_output`、`local_shell_call_output`、`shell_call_output`、`apply_patch_call_output`、`program_output` |
| MCP 审批 | `mcp_approval_request`、`mcp_approval_response` |
| 上下文管理 | `compaction`、`compaction_trigger`、`item_reference` |
| 程序化调用 | `program`、`program_output` |

`message.content[]` 还包含 text、image、file 等输入内容。正文和二进制负载继续由 Raw 与字段级 lazy payload 负责；当前 Protocol v1 仍把 Responses message 作为一个条目投影，资源类型、顺序和嵌套路径的独立摘要属于 P1，不能把这一计划写成已实现行为。

### 工具定义

当前官方工具 union 约 16 类：`function`、`custom`、`namespace`、`tool_search`、`mcp`、`file_search`、`web_search`、`web_search_preview`、`computer`、`computer_use_preview`、`code_interpreter`、`image_generation`、`local_shell`、`shell`、`apply_patch`、programmatic tool calling。

PMA 必须递归处理任意深度 namespace；namespace 是容器，不是可调用叶子。`defer_loading`、`additional_tools`、`tool_search_output` 和 MCP list-tools 共同构成工具可用性时间线。

### 下行与流式事件

官方 `ResponseOutputItem` 当前约 28 种，基本覆盖上述消息、推理、工具发现/调用/结果、审批、压缩和程序化调用类型。顶层 Response 约 34 个字段，PMA 的主要事实是 `status`、`error`、`incomplete_details`、`output`、`usage`、`model`、`service_tier`、上下文连续性和服务端回显的工具配置。

`ResponseStreamEvent` 当前约 53 种。PMA 按事件族而不是复制 53 个 Renderer：

- Response 生命周期：created、queued、in_progress、completed、failed、incomplete、error；
- output item/content part：added、done；
- text/refusal/audio/audio transcript：delta、done；
- reasoning text/summary：part added/done、text delta/done；
- function/custom tool 参数：delta、done；
- file/web/code interpreter/image generation/MCP：in_progress、searching/interpreting/generating、completed/failed 及专用 delta；
- annotations 与 MCP list-tools。

最终 terminal response 是完整事实；terminal 缺少 output 时，才使用按 `output_index` 收集的 item 重建。PMA 不把逐 delta 伪装成多个模型回复。

## OpenAI Chat Completions

Chat Completions 保留为 OpenAI-compatible Harness 的兼容层，而不是新机制能力的首选协议。

- 顶层请求当前约 37 个字段；P0 是 `messages`、`model`、`tools`、`tool_choice`、`parallel_tool_calls`、`reasoning_effort`、`response_format`、`modalities`、`stream`。
- message role union 为 `developer`、`system`、`user`、`assistant`、`tool` 和已废弃 `function`。
- 用户 content part 至少覆盖 `text`、`image_url`、`input_audio`、`file`。
- Assistant 下行需要保留 text/refusal/audio、annotations、`tool_calls` 与旧 `function_call`。
- 流式响应以 `choices[].delta` 累加，多个 choice 必须保持独立，不能合并成一个虚构回复。

Chat 的其余采样、logprob、prediction、web-search option 和缓存字段属于 P1/P2，继续由 Metadata/Raw 展示。

## Anthropic Messages

### 顶层请求与连续性

当前 `MessageCreateParamsBase` 约 19 个字段：`max_tokens`、`messages`、`model`、`system`、`tools`、`tool_choice`、`thinking`、`output_config`、`container`、`cache_control`、`metadata`、`service_tier`、`stop_sequences`、`stream`、`inference_geo`、`user_profile_id`，以及逐步废弃的 `temperature`、`top_k`、`top_p`。

P0 是 `system`、`messages`、`tools`/`tool_choice`、`thinking`、`output_config`、`container`；缓存、区域、用户归属和服务等级为 P1；采样参数为 P2。

### 输入 content blocks

当前 `ContentBlockParam` union 约 17 种：

- 对话与指令：`text`、`mid_conv_system`；
- 资源：`image`、`document`、`search_result`、`container_upload`；
- 推理：`thinking`、`redacted_thinking`；
- 客户端工具：`tool_use`、`tool_result`；
- 服务端工具：`server_tool_use`、`web_search_tool_result`、`web_fetch_tool_result`、`code_execution_tool_result`、`bash_code_execution_tool_result`、`text_editor_code_execution_tool_result`；
- 动态工具：`tool_search_tool_result`，其内部 `tool_references[]` 指向刚加载的 deferred tools。

`tool_result.content[]` 内还允许 `tool_reference`，因此动态工具引用必须递归检查已知容器，不能只扫描顶层 block。

### 工具定义与下行

当前工具 union 约 19 个版本化成员，包括普通 client tool、bash、memory、text editor、四代 code execution、三代 web search、四代 web fetch，以及 regex/BM25 两种 tool search。PMA 不为每个日期版本写独立分支；以 `name`、`type`、`defer_loading`、`allowed_callers`、`strict` 和 schema 路径投影共同机制。

Anthropic 下行 `ContentBlock` 当前约 12 种：`text`、`thinking`、`redacted_thinking`、`tool_use`、`server_tool_use`、五类 server-tool result、`tool_search_tool_result` 和 `container_upload`。顶层 Message 的 P0/P1 字段是 `content`、`stop_reason`、`stop_details`、`usage`、`container` 和 model。

流式协议只有 6 个外层事件：message start/delta/stop 与 content-block start/delta/stop；但 content delta union 包含 `text_delta`、`input_json_delta`、`citations_delta`、`thinking_delta`、`signature_delta`。PMA 必须保留未知 block，已知 delta 只合并回原生 block，不生成 PMA 私有的伪协议字段。

## Harness 归因边界

协议层可以证明“这里有一个 user message”“这里发生了 compaction”“这里加载了某个 deferred tool”，但不能仅凭文本证明“这一定是某 Harness 注入的 Skill/Memory”。Harness Adapter 只有在以下证据存在时才归因：

- wrapper/adapter 保存的 provenance；
- 只在本机使用并在上游转发前剥离的证据 header；
- 官方协议中的明确类型、client metadata 或生命周期 id；
- 经过真实 Trace 验证、误判边界清楚的强结构指纹。

无法与真实用户消息区分的普通 `user` 文本必须保持 `user_message` 或 unknown。Raw、协议事实、Harness 归因和启发式推断在 UI 中不得合并成一个无来源结论。

## 实施优先级与验收

### P0：机制闭环

- 所有正式 message/item/content-block 顶层类型获得非破坏性分类和 Raw JSONPath；
- instruction/context/tool inventory/tool call/tool result/reasoning/response/termination 顺序正确；
- namespace、deferred tool、tool search、MCP list/approval、Anthropic server tools 和 tool references 可见；
- Responses、Chat、Anthropic SSE 能重建最终原生响应；
- 未知类型显式进入 unknown 统计，不能静默冒充普通 message。

### P1：诊断、资源与隐私

- usage/cache、error/refusal/incomplete、server/client caller 和结构化输出约束进入整理信息；
- image/file/audio/document/container 只展示类型、大小、来源和懒加载入口；
- authorization、user/profile id、conversation id、encrypted reasoning/search content 等敏感字段不复制进协议摘要。

### P2：完整配置查阅

- 生成参数与版本化工具的全部内部字段继续通过 Raw/Metadata 查看；
- 只有真实用户反馈证明其影响 Harness 机制时，才升级为专用语义。

每次官方 Schema 漂移更新至少需要：官方来源链接、受影响 union 清单、脱敏 fixture、直接 contract smoke、未知类型回退断言，以及对本文覆盖表的更新。
