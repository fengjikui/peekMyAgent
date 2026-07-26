# Trace 请求画像契约

更新时间：2026-07-26

`src/trace/request-profile.mjs` 把一条 Capture 的路径、请求 body、header 和已归一化消息语义解释为稳定的请求画像。它回答“这是什么协议、哪个 provider、谁发起、与当前对话是什么关系、正在做什么”，但不建立 Turn 或子 Agent 血缘。`src/trace/request-attribution.mjs` 负责生成跨 Harness 共用的归因结构。

## 所有权

该模块负责：

- 汇总顶层 `system` 与 role=`system` message，保留其原始位置；
- 识别 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses 与 Gemini Generate Content 请求形状；
- 根据 model 与 capture endpoint 提示推断 provider，并记录 `thinking`、`reasoning_content` 扩展；
- 识别 `/context` token 统计、会话标题生成、WebSearch 内部请求；
- 按证据优先级区分 `main`、`subagent`、`parent_spawn`、`metadata` 与独立 `background` 请求。
- 为每个来源画像输出 `actor`、`relation`、`operation`、`confidence` 与可检查的 `evidence`。

该模块不负责：

- 捕获、持久化或修改请求；
- 解析模型下行 SSE/JSON；
- 建立 parent/child 实例、Context Delta 或 Turn；
- 生成 Viewer HTML、统计页面数量或执行 provider 配置。

## 请求来源优先级

来源分类不是相互独立的布尔标签，而是有顺序的决策：

1. 明确的传输路由（如 Responses compact/search endpoint）先识别；
2. Codex `client_metadata["x-codex-turn-metadata"]` 的协议字段识别 `prewarm`、`compaction`、`memory` 和未来新增的非 `turn` 任务；
3. `/context`、Suggestion、framework reminder、标题生成与 WebSearch 等内部请求归为 `metadata`；
4. `x-claude-code-agent-id`、Codex `thread_source=subagent`/`parent_thread_id`、debug source 或其他 Subagent marker 归为 `subagent`；
5. 历史中最新的 `Agent`、`sessions_spawn` 或 `subagents` tool use 归为 `parent_spawn`；
6. 其余请求归为 `main`。

metadata 必须先于子 Agent header 判定。例如 Claude Code 的 `/context` 内部请求即使携带 Agent header，也不能制造一条子 Agent 分支。

当前统一处理矩阵：

| 机制 | 主要证据 | actor | relation | 时间线与 Context 处理 |
| --- | --- | --- | --- | --- |
| 普通模型 Turn | 未命中更强规则；Codex `request_kind=turn` | `main_agent` | `current_dialogue` | 参与主链和用户 Turn |
| 子 Agent 推理 | Agent header、Codex `thread_source=subagent` 或父线程标记 | `subagent` | `child_dialogue` | 独立子 Agent 链，归入父 Turn 的多 Agent 视图 |
| 启动子 Agent | 当前上行历史中的 spawn tool call | `main_agent` | `current_dialogue` | 标记父级启动，不冒充子 Agent 请求 |
| Responses 连接预热 | Codex `request_kind=prewarm` | `harness` | `current_dialogue` | `turn_placement=next_turn`，首轮前暂存后归入首个真实 Turn；不生成模型回答 |
| 生成会话标题 | 标题专用 system/schema、OpenCode 标题提示或 debug source | `harness` | `current_dialogue` | OpenCode 等使用 `turn_placement=trigger_turn`；Claude Code 在可见轮次间发起标题请求时使用 `turn_placement=next_turn`，避免污染上一轮 |
| 上下文压缩 | compact endpoint 或 Codex `request_kind=compaction` | `harness` | `current_dialogue` | 当前对话内部重要机制；不生成用户 Turn，但主时间线保留上行和模型下行 |
| 记忆提取 | Codex `request_kind=memory` | `background_service` | `independent` | 独立 side chain，可检查但不污染当前 Turn |
| `/context` 统计、标题、建议、框架提醒、内部搜索 | transport path、debug source 或强消息语义 | `harness` | `current_dialogue` | 内部请求，按机制展示，不成为用户输入 |
| 未知显式非 `turn` kind | 协议字段存在但语义尚未登记 | `background_service` | `independent` | 保留原始证据并显式标为通用后台任务，等待样本后升级规则 |

## 统一归因模型

`source_hint` 同时保留兼容旧展示的 `type`，并提供四个正交维度：

- `actor`：发起者，如 `main_agent`、`subagent`、`harness`、`background_service`；
- `relation`：与用户当前对话的关系，如 `current_dialogue`、`child_dialogue`、`independent`；
- `operation`：实际机制，如 `model_turn`、`context_compaction`、`codex_memory_extraction`；
- `turn_placement`：对话内机制相对用户 Turn 的落位提示；当前使用 `trigger_turn` 与 `next_turn`，不替代 `relation`；
- `evidence`：支持判断的结构化证据，记录 `origin`、`field` 与低敏值。

这几个维度不能相互替代。Harness 发起的压缩属于当前对话；Harness 发起的记忆提取则是独立任务。子 Agent 属于当前任务的子对话，但不能并入主 Agent 的 Context Delta 链。

证据按“传输路由、请求体协议字段、请求头、消息语义、显式 debug 标记、低置信兜底”解释。请求头是重要证据源，但不能假设每个 Capture backend 都保留全部 Header，也不能把某个容易变化的 Header 当作唯一协议。确切的 thread/session/window ID、父线程 ID 和其他可能关联用户活动的值不得复制进归因摘要；只记录字段存在。稳定枚举值（例如 `request_kind=memory`）可以保留，便于用户验证推断。

## Codex 后台请求归因

Codex 精确代理同时观察请求头和请求体。当前持久化会脱敏敏感 Header；代理在脱敏前只把 `request_kind`、`thread_source`、`subagent_kind`、`sandbox` 等白名单枚举写入 `header_semantics.codex_turn_metadata`，并把父线程/子 Agent Header 记录成存在性布尔值，绝不保留其中的 ID。请求体中的 `client_metadata["x-codex-turn-metadata"]` 仍是可与原始上行对照的主要证据；安全 Header 语义用于请求体不再重复元数据时的可靠兜底。已观察到的稳定字段包括：

- `request_kind=turn`：正常模型 Turn；
- `request_kind=prewarm`：当前对话的 Responses 连接预热；官方实现使用 `generate=false`，不生成模型回答；
- `request_kind=compaction`：当前对话内的上下文压缩机制；
- `request_kind=memory`：分析历史 rollout 的独立后台记忆提取；
- `thread_source=subagent`、`parent_thread_id` 与 `subagent_kind`：子 Agent 归属证据。

`request_kind` 的当前完整枚举以 Codex 官方源码中的 `CodexResponsesRequestKind` 为准：`turn`、`prewarm`、`compaction`、`memory`。其中仅 `memory` 不携带 Turn identity；`prewarm` 由会话启动流程建立，并在首个正常 Turn 复用。来源：[responses_metadata.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/responses_metadata.rs)、[session_startup_prewarm.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/session_startup_prewarm.rs)。

`memory` 和未来未知的显式非 `turn` kind 必须归入独立 `background` context chain。它们仍保留完整上行与下行供用户研究，但不得成为用户输入、不得新建幽灵 Turn，也不得影响主对话的历史增量和“本轮工具活动”。`compaction` 与当前对话有关，归为内部 metadata，但同样不作为用户输入。

归因不等于隐藏。`compaction` 是用户研究上下文机制时的重要证据，因此在主时间线直接展示请求及其模型回复。会话命名、预热等辅助请求不独占 Turn，默认收在可展开的幕后请求时间线中；一旦展开，任何已经捕获的模型回复仍必须可见和可进入 Raw 详情。

Viewer 将独立 `background` chain 渲染成带具体机制名称的旁路节点，例如“Codex 后台任务 · 记忆提取”，并明确标注“独立于当前对话”。旁路节点保留请求编号、Assistant 回复和完整 Raw/Metadata 入口，但不进入用户 Turn 编号、Turn Rail、Turn 统计或 latest-only 的候选集合；因此后台任务既可被观察，也不会冒充主对话的一轮。

相同的 `thread-id`、`session-id` 或 conversation ID 只说明客户端实现上的技术归属，不能证明请求属于当前用户对话。真实样本中的 Codex `memory` 请求会复用主对话的 thread/session；因此 `request_kind`、传输路由与其他协议证据必须优先于会话 ID。

模型名称、`x-codex-window-id` 后缀和提示词文本只能用于诊断或低置信兜底，不能作为主分类条件。`x-codex-beta-features` 只说明客户端具备某项能力，也不能证明某一次请求正在执行该能力。

## 证据边界

这里的 `source_hint.confidence` 表示语义分类证据，不等于 Capture provenance 的正文 fidelity 或 request/response association confidence。它不能用来宣称请求是网络层 exact capture。Viewer 的 Metadata 整理页可展示归因结果与脱敏后的证据；紧凑时间线 DTO 不携带证据数组，避免大 Trace 重复膨胀。

provider 是根据 model/endpoint 提示得到的展示画像；unknown 是合法结果。新增 provider 时，先增加直接 fixture，再扩展本模块，不能在 Server 或 Viewer 中散落 model-name 判断。

## 验证

```bash
npm run smoke:request-profile-contract
```

直接契约覆盖 system 提取、四类协议、现有 provider、reasoning 扩展、所有 metadata/subagent/parent-spawn 判定分支和依赖方向。`smoke:claude-internal-turn`、`smoke:subagent-otel`、`smoke:agent-trace-view`、Proxy 与 Trae smoke 继续验证真实 Server 装配兼容。
