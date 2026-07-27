# Protocol Exchange 投影契约

更新时间：2026-07-27

`src/trace/protocol-exchange.mjs` 把一次已捕获的模型上行请求和下行响应投影为稳定的 `protocol_exchange` DTO。它的目的不是发明一套替代厂商协议，而是让 Viewer 在保留 Raw 事实的同时，用同一组语义展示指令、消息、工具声明/追加/加载、工具调用/结果、推理和回复。

核心边界是：**协议解析提供事实，Agent Adapter 提供归因，启发式只提供可撤销的推断。** `protocol_exchange` 不根据 Agent 名称重写协议，也不替代 Raw Inspector 中保存的原始 request/response。

## 数据流

```text
Capture request/response Raw
  -> request-profile 识别协议
  -> shared request-payload 递归投影工具目录
  -> protocol-exchange 按厂商协议投影
  -> ViewerTraceProjector 保存完整 protocol_exchange
  -> Timeline projector 只保留卡片需要的 counts + status
  -> Protocol View Model / Renderer 展示并跳回 Raw 证据
```

完整 DTO 由单请求详情、Raw Protocol 页和上行详情使用；compact Timeline DTO 只保留协议身份、卡片实际读取的上下行计数和响应状态。它不得携带 `instruction_blocks`、`input_items`、`tool_stages` 或 `output_items`；打开协议详情时由既有单请求详情接口取得完整工具目录，避免在长 Timeline 中为每条请求重复 namespace、工具名和路径。

## v1 DTO

顶层字段：

- `schema_version`：当前为 `1`；
- `protocol` / `protocol_label`：协议稳定 ID 和展示名称；
- `request.instruction_blocks`：指令事实及其 Raw JSONPath；
- `request.input_items`：按协议原顺序投影的上行条目；
- `request.tool_stages`：工具 `declared`、`added`、`loaded` 阶段及阶段后的有效工具数；每个阶段分别保留 namespace 容器和可调用叶子工具；
- `request.counts`：指令、input、角色、工具结果、工具阶段和有效工具计数；
- `response.output_items`：按协议原顺序投影的下行条目；
- `response.counts` / `response.status`：消息、推理、调用、结果和协议终态摘要。

每个条目保留 `source_path`、协议原生 `item_type`、规范角色、语义、字符近似值以及可用的 `call_id`、工具名。Viewer 中的每个协议条目必须能跳回相应 Raw section；协议页不是第二份正文查看器。

工具目录由 `src/shared/request-payload.mjs` 按树解析，Protocol Exchange、Viewer 摘要、Tools 翻译材料和动态工具发现整理视图共用这一事实源。`type=namespace` 是容器，不计入有效工具数；容器保留 `qualified_name`、`source_path` 和递归叶子数。叶子工具保留原始 `name`，同时生成限定名（例如 `collaboration.followup_task`）、完整 namespace 路径和精确 Raw JSONPath（例如 `$.input[0].tools[3].tools[0]`）。解析器递归处理任意深度 namespace，不能假设只有一层，也不能因为遇到未知容器字段而丢弃 Raw 结构。需要 schema 的内部消费者可以请求原始 definition 引用；Protocol DTO 不携带该引用，原始容器树继续只由 Raw 保存。namespace 与叶子目录只进入完整 DTO；compact DTO 仅保留其计数。

## 当前协议覆盖

| 协议 | 上行 | 下行 | 当前限制 |
| --- | --- | --- | --- |
| OpenAI Responses | `instructions`、`input`、顶层 `tools`/`additional_tools`、input 中的 `additional_tools` 与 `tool_search_output`；namespace 工具目录递归展开为限定名叶子 | `output` 中的 reasoning、message、function/custom/built-in tool call 和 tool result | 以最终捕获/归一化响应投影，不展示逐个 SSE delta |
| OpenAI Chat Completions | system/developer/user/assistant/tool messages 与工具声明 | `choices[].message`/`delta`、`tool_calls` 和旧 `function_call` | 多 choice 逐项投影，不合并成虚构的单一回复 |
| Anthropic Messages | `system`、`tools`、message content 中的 text、thinking、`tool_use`、`tool_result` | response `content` blocks | 保留 content-block 顺序，不从工具名推断 Agent 生命周期 |
| Google GenerateContent | `systemInstruction`、`contents[].parts`、`functionDeclarations` 和已知 built-in tool 声明 | `candidates[].content.parts` 中的 text、thought、function call/response | 未识别的 part 仍作为普通协议条目保留，不猜测其含义 |
| Unknown | 只做保守的 messages/tools 摘要 | 不伪造下行序列 | Raw 是唯一事实入口 |

OpenAI 官方定义 `additional_tools` 为有序 input item：`role` 是 `developer`，其中工具只在该条目出现之后可用。因此它在 PMA 中是 `tools_added`，不是空 Developer 消息；input 中的相对位置必须保留。参考 [OpenAI Tool Search](https://developers.openai.com/api/docs/guides/tools-tool-search#add-tools-at-a-specific-point-in-the-input)。

## 翻译与隐私

Protocol 页只展示结构和计数，不自行发送翻译请求。用户显式触发翻译时：

- System、Developer instruction、Tools schema/Harness、Assistant reasoning/response 可以形成翻译材料；
- 用户消息、历史对话和工具结果保持原文，不自动进入翻译材料；
- Developer instruction 和 Assistant output 可能包含项目规则、源码片段或模型结果，发送目标仍由现有 Translation provider/Harness policy 决定；
- 材料通过 stdin 或既有安全 provider 边界传递，不加入进程命令行；缓存和 manifest 使用既有私有权限与脱敏规则。

界面必须把这一动作标为用户主动操作，不能因为打开 Protocol/Developer/Response 页就自动把内容发送给翻译 provider。

## 扩展新协议

1. 先在真实 Raw fixture 中确认协议字段和顺序；
2. 在 `request-profile.mjs` 建立保守识别，不能用 Agent 名称替代协议证据；
3. 在 `protocol-exchange.mjs` 注册纯 adapter，并为每个语义保留 Raw JSONPath；
4. 对工具声明、调用、结果、推理、回复和未知条目增加直接 contract smoke；
5. 若新增 UI 文案，同步中英文 i18n；
6. 若新增可翻译材料，更新翻译材料契约并复核数据外发边界；
7. 用真实 Trace 做浏览器验收，但不得把真实 prompt、认证信息或未脱敏截图提交到仓库。

## 聚焦验证

```bash
npm run smoke:protocol-exchange-contract
npm run smoke:protocol-exchange-view-contract
npm run smoke:request-profile-contract
npm run smoke:timeline-view-projector-contract
npm run smoke:viewer-trace-projector-contract
npm run smoke:raw-view-model-contract
npm run smoke:raw-inspector-renderer-contract
npm run smoke:translation-materials-contract
npm run smoke:viewer-i18n-contract
```
