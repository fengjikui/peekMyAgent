# Codex rollout 证据与 Viewer 契约

更新时间：2026-07-19

本文记录 Codex Desktop 本地 rollout 在 peekMyAgent 中如何成为可解释 Trace，以及共享 Viewer 如何诚实区分网络原文、语义重建和 Harness 生命周期事件。产品启动与会话选择见 [Codex 捕获产品决策](codex-capture-product-decisions.md)，底层实验见 [Codex Desktop 捕获研究](codex-desktop-capture-research.md)。

## 核心原则

peekMyAgent 面向希望学习 Harness 工作机制的用户。默认视图必须先回答“这一轮发生了什么”，再允许下钻到“这条结论来自哪份证据”。任何 adapter 都不得为了复用请求卡而把本地事件伪装成 HTTP 请求，也不得把语义重建称为完整 wire capture。

证据有两个互不替代的维度：

1. **artifact fidelity**：request 或 response 正文是 `exact`、`partial` 还是 `missing`。
2. **association confidence**：上下行依靠同一 capture 生命周期、trace/span、thread/turn 还是启发式顺序关联。

持久化层使用内容块重建 JSON，只表示存储表示法，不会把原本 exact 的 Proxy Capture 降为语义重建；同样，也不会把 rollout 重建升级成 exact wire evidence。

## 当前证据类型

| 来源 | request | response | 关联 | Viewer 默认文案 |
| --- | --- | --- | --- | --- |
| Capture Proxy | 原始网络正文，未截断时 `exact` | 原始网络正文，未截断时 `exact` | 同一 capture 生命周期 | 完整请求 / Response |
| Claude OTel raw body | Agent 遥测正文，可为 `exact` | Agent 遥测正文，可为 `exact` | trace/span 或最终文件顺序 | 由 provenance 决定 |
| Codex rollout | observed upstream delta 的语义重建，`partial` | rollout downstream item 的语义重建，`partial` | thread + turn/exchange，`high` | 重建上行 / 重建下行 |
| semantic event | 本地 Harness 生命周期事件 | 不存在 | 不适用 | 事件原文 / 事件 Metadata |

`src/trace/evidence-profile.mjs` 将 adapter provenance 和 capture 内的限制条件投影为 `summary.evidence`。Viewer 只消费这个共享画像，不按 `agent_profile === "Codex"` 写第二套完整度判断。

## Codex rollout 映射

`src/adapters/codex-rollout-normalizer.mjs` 只读选中 thread 的 rollout JSONL，并按稳定 turn/exchange 映射为共享 Capture 形状：

- `session_meta.base_instructions` 映射为 System 参考；它来自本地 rollout，不宣称等同于 wire request 的逐字 `instructions`。
- `session_meta.dynamic_tools` 映射为 Tools schema；当前只覆盖 rollout 中公开的动态工具，内置工具可能缺失。
- 归一化证据同时保留 `tool_schema_origin = codex_session_meta.dynamic_tools` 和动态工具数量，避免以后把会话元数据误读为逐次 wire schema。
- 当前 exchange 之前观察到的 `developer/system/user` message、工具结果与 `agent_message` 映射为 observed upstream delta。
- `reasoning`、assistant message、function/custom tool call 和 web search call 映射为重建下行。
- 加密 reasoning 和子 Agent task payload 默认只显示存在性与安全摘要；原始 rollout 仍是最终本地证据。
- usage、finish reason、model、cwd、thread id、turn id 和 context window 在有本地事件时保留。

因此 rollout 模式明确声明：

```text
exact_wire_request = false
input_scope = observed_upstream_delta
full_request_history_available = false
tool_schema_scope = dynamic_tools_only | not_present_in_rollout
tool_schema_origin = codex_session_meta.dynamic_tools | null
tool_schema_count = <non-negative integer>
```

观察到某次 `tool_use` 只证明模型返回了该调用，不能反推出 rollout 未记录的工具描述或参数 schema。真实 Codex rollout 可能同时出现 `exec` / `exec_command` 调用和仅含 `codex_app` / plugin 动态工具的 session metadata；PMA 必须保留这一差异，不能为已观察调用伪造 schema。Tools 整理页因此把这部分标成会话动态工具清单；Response 旁的 Tools schema 也仍是上行参考，不属于 response body。

重建 body 保留 OpenAI Responses 的规范 `input`，不再同时写入内容相同的派生 `messages`。共享 Trace Domain 在需要角色语义时从 `input` 投影 message；Raw 的完整请求因此不会伪造第二份历史，体积统计也不计算重复副本。完整请求标签页只渲染一次完整对象，System、Tools、Harness、Messages 和 Metadata 由各自标签页提供整理视图。

## Harness 注入

Codex 会在普通 developer/user message 中放入 XML-like Harness 标签。共享语义层只识别白名单：

- runtime：运行环境、界面状态、App 上下文；
- capability：Skills、Apps、Plugins 与推荐插件；
- policy：协作模式与权限策略；
- memory：持久记忆的读取规则与记忆摘要；
- orchestration：主 Agent、子 Agent 与并发槽位的编排契约；
- internal：内部目标；
- lifecycle：Turn 生命周期；
- subagent：子 Agent 通知。

标签解析采用平衡扫描。若注入正文为了讲解规则再次出现一对同名标签，内层示例属于外层正文，不会提前结束区块。`multi_agent_mode` 作为编排启动策略单独展示；无标签的 developer 正文只在命中经过真实 rollout 验证的强指纹时识别为 Memory 或多 Agent 编排，其他内容仍使用通用 developer 标签。整理/翻译视图按语义分类；未知标签和全部原始 role、顺序、正文仍保留在 Raw 中。

## 生命周期事件

`src/trace/capture-semantic-event.mjs` 定义版本化 semantic event：

```text
schema_version
category: context_lifecycle | agent_lifecycle | harness_lifecycle
type
actor: harness | agent | user
source
evidence
data
```

当前 Codex `context_compacted` 映射为 `context_lifecycle`：时间线使用共享 semantic-event View DTO 显示进入的窗口编号、replacement history 条目数、保留消息角色与数量、不透明 compaction 数量，以及紧随 `compacted` 记录出现的本地 post-compaction token 估算。Codex 将这份 replacement history 安装为新的 live history，后续 prompt 从这里继续；该结论来自 Codex 的 rollout reconstruction 与 history replacement 实现，而不是根据 UI 文案猜测。

精确代理中的 `POST /v1/responses/compact` 是另一种证据：它证明 Codex 向 first-party compaction endpoint 发送了什么以及端点逐字返回了什么，但单凭该交换不能恢复 rollout 随后安装 replacement history 的本地生命周期细节。Viewer 因此把它标记为 Harness 上下文压缩请求，保留完整 Raw request/response，同时不把它显示成新的用户 Turn。`POST /v1/alpha/search` 同样作为 Codex 内置搜索服务交换处理。两类 path 语义都来自实际传输路径，不从正文关键词猜测。

token_count 中 `last_token_usage.total_tokens` 是压缩完成后由 Codex 本地重算的粗略估算，不是 tokenizer 精确值，也不等于下一次模型 HTTP 请求的 `input_tokens`。默认卡片必须同时呈现这一限制。该事件本身也不是一次模型请求，因此：

- method 为 `EVENT`，path 为 `/codex/rollout/context_compacted`；
- 不生成伪 System、Tools、Messages 或 Response；
- Raw 只显示事件原文和事件证据元数据；
- 原始 replacement history 继续保留在本地 rollout 证据中。

未来 Harness 的暂停、恢复、checkpoint、memory commit 或 delegation lifecycle 若没有对应模型交换，也应走 semantic event，而不是创建假的 user request。

## Viewer 默认信息架构

### Turn 机制流程

复杂 Turn 默认先显示一条紧凑的机制流程，再展示请求卡证据。例如：

```text
用户请求 -> 模型调用 exec（内部派发 exec_command） -> exec 结果回传（含 exec_command） -> 最终回答
用户请求 -> 读取 Skill 指令 -> Skill 内容回传 -> 调用工具 -> 结果回传 -> 最终回答
用户请求 -> 启动 2 个子 Agent -> 启动确认 2/2 -> 结果回流 2/2 -> 最终回答
用户请求 -> 最终回答 -> Harness 压缩上下文
```

`turn-story-model.js` 只读取共享 `summary.entry`、`summary.response.tool_calls`、`summary.current_tool_results`、semantic event 和 `agent_trace`，不读取 Agent 名称。外层工具已带有高置信嵌套工具语义时，流程优先显示实际观察到的内部工具名；原始外层调用仍保留在请求卡和 Raw。子 Agent 流程按实例图聚合 spawn、launch acknowledgement 和 result return，不把每个底层 orchestration call 重复铺开。没有工具交换、Harness 生命周期事件或子 Agent 分支的普通问答不显示机制流程；底层即使夹有隐藏请求，也不能制造装饰性流程。

每个可定位步骤都保存 request id/index，并通过共享请求跳转动作回到证据；该动作同时供多 Agent 看板使用。流程是导航和解释层，不会替代原始顺序、字段或证据完整度标签。

### 普通模型交换

1. 中栏先显示用户可见输入、Assistant 回复、thinking 摘要和本轮工具交换。
2. 上行详情包含 System、Tools、Messages、Harness 注入和本次工具结果；不会把本次 response 的 tool call 混入上行。
3. Response 详情包含本次重建/原始下行、tool call、usage 与 stop reason。
4. Response 中的 Tools schema 放在“上行参考”，明确它由 Harness 在请求前注入，不是模型返回内容。
5. Raw 标题由证据画像决定使用“完整”还是“重建”，所有派生展示都可回到原始证据。
6. 若已捕获工具参数明确包含 `tools.<name>(...)` 或 `skills/<name>/SKILL.md`，Trace Domain 可附加“嵌套工具派发”或“Skill 指令读取”高置信标注；Timeline 同时保留外层工具名和原始参数，不把该标注表述为未观测的远端调用。

证据边界不能只藏在 Raw 中。`src/viewer/evidence-view-model.js` 根据 Source provenance 和 `summary.evidence` 生成共享展示 DTO：Codex rollout 在左侧会话项直接附加“语义重建”，请求卡使用“展开/折叠重建上行”和“重建上行详情”；Capture Proxy 等 exact 来源继续使用普通“上行”。`summary.evidence.sections` 进一步记录 System、Tools、Messages、Harness 的 `source`、`origin`、`scope`、`fidelity` 与派生属性。右侧整理视图据此用一条紧凑来源说明区分“当前 Turn 已观测上行增量”“rollout 会话动态工具清单”“PMA 整理分类”和“完整 request”；共享上行详情同样按 Messages scope 把 rollout 当前 Turn 输入项标成“观测输入增量”，不称为完整 History，也不再把同一组输入重复渲染成“本轮新增消息”。Response 旁保留的 Tools schema 始终标为上行参考。请求 Metadata 还只读投影 `upstream_evidence`，供深度检查来源、范围与动态工具数量，不混入下行证据。该模型只读取证据字段，不读取 Agent 名称，因此未来 Harness 只需正确输出 provenance 和区块范围即可复用同一信息架构。

### 子 Agent

默认看板按 Agent 实例组织，事件条按时间顺序保留交错关系：

```text
spawn -> launch acknowledgement -> child activity -> business result return
```

Codex `spawn_agent` 是启动信号；紧随其后的 `function_call_output` 若只返回 task name，是启动确认而非业务结果；带 `FINAL_ANSWER` 的 `agent_message` 才是结果回流。看板同时显示继承/隔离上下文、稳定子 Agent 编号、spawn/launch/return 请求号和关联信号。任务正文若在 rollout 中仅保存为加密载荷，看板只说明其可见性而不复制密文；明文任务则显示受限摘要。紧凑 Timeline 会保留这些 semantic annotations 与 `subagent_result` entry，使后续分页或重新组图时不依赖已裁掉的 Raw body。原始 call id、author、recipient 与 rollout event 仍可在详情中查看。

## 新 Harness adapter 接入约束

新 adapter 应输出共享 Capture/provenance，而不是新增一套 Viewer：

1. 保存或引用原始来源，不丢弃未知字段。
2. 明确 request/response 的 origin、fidelity、artifact 和 association。
3. 将模型交换映射到共享 System、Tools、Messages、tool call/result、response 原语。
4. 将非模型生命周期映射为 semantic event。
5. provider 独有标签只在 Trace Domain 建立白名单语义；Raw 不改写。
6. 子 Agent adapter 提供可验证的 spawn、child identity、return 关联证据；缺失时诚实标记低置信度。
7. adapter 或 Trace Domain 应把整理区块的来源和范围归一化到共享 section evidence；Viewer 不得根据 Agent 名称反推完整度。
8. Viewer 通过 evidence profile、协议画像和共享领域 DTO 展示；不得在 renderer 散落 provider 分支。

只有协议确实独有的信息才增加可选领域字段。字段命名可以保留 provider 原词，但默认解释文案必须说明它对应上行、下行还是 Harness 本地事件。

## 回归证据

确定性契约至少覆盖：

- rollout request/response 重建与 limitations；
- exact Proxy 与 rollout 在 Raw 中的不同标签；
- exact Proxy 与 rollout 在左侧 Source 和请求卡中的不同默认文案；
- semantic event 不出现请求/回复标签；
- 同名嵌套 Harness 标签不会截断；
- response tool call 不进入上行 current tool calls；
- Turn 机制流程按请求顺序关联工具/Skill 结果，并可跳回对应请求证据；
- “子 Agent”筛选保留所属 Turn 的机制流程与多 Agent 看板；
- spawn、启动确认、结果回流和跨页关联；
- compact 首屏、迟到 response 覆盖与稳定 request id。

功能改动还需使用真实 Codex Desktop thread 验证普通多轮、工具闭环、Skill、并行子 Agent、压缩及压缩后继续对话，并用真实浏览器查看时间线、Raw、翻译和多 Agent 看板。测试产生的临时观察对象和进程应在验证后清理。
