# Trace Context Delta 契约

更新时间：2026-07-12

Trace Context Domain 当前由两个模块组成：

- `src/trace/message-equivalence.mjs`：定义历史消息等价与公共前缀。
- `src/trace/context-delta.mjs`：按 context chain 选择前驱，并计算历史复用、固定上下文变化和本轮工具事件。
- `src/trace/turn-timeline.mjs`：把已解释 request 组织为用户轮次，并累计内部请求、工具交换和 context delta。

## 消息等价

消息比较会：

- 统一字符串 content 与单个 `{type: "text", text}` block；
- 递归忽略 `cache_control`；
- 保留 role、文本、tool id、tool arguments/result 等语义字段；
- 使用稳定 key 顺序生成等价键。

因此，仅 cache breakpoint 或协议表示方式变化不会导致整段历史被误判为新增；真实文本、角色或工具内容变化仍会中断公共前缀。

## Context chain

前驱请求按以下 key 分组：

1. 有子 Agent ID：`agent:<session>:<agent-id>`；
2. 主 Agent：`main:<session>`；
3. metadata/side request：`<actor-type>:<session>:<source>`。

子 Agent 与主 Agent 不互相做差值，多个子 Agent 也按实例 ID 独立比较。

## 输出

每个 request 保持现有 DTO：

- `trace.context_chain_key` 与 `previous_context_request_index`；
- `changes.system_changed/tools_changed/params_changed` 及数量差；
- `context_delta` 的 baseline、复用比例、新增角色、工具调用/结果、fixed context 和 preview；
- history stack 每条消息的 `baseline/reused/new`；
- `summary.current_tool_calls/current_tool_results` 只表达本轮新增工具事件。

## Turn timeline

Turn 以规范化后的真实用户输入作为边界。metadata、harness 和子 Agent 请求属于内部请求：当它们携带不同输入时先暂存，并在主 Agent 回到当前用户轮次时并入，不产生幽灵 Turn。每个 Turn 累计 request index、时间范围、主/内部/子 Agent 数量、工具调用/结果、Raw 字节和 context delta。

消息的 harness/compact/command/suggestion/task notification 分类仍由 Viewer message semantics policy 注入。Context Domain 不解析 Claude Code 标签，也不依赖 HTTP、SQLite 或浏览器。

## 回归约束

- 单一会话中的主 Agent、每个子 Agent、metadata 请求必须独立维护前驱。
- 工具结果消息尾随普通文本时仍属于工具回流。
- internal metadata 请求不得继承普通工具事件。
- Context Domain 只注解 request DTO，不修改原始 capture body。
- 每个 request 只能归属一个 Turn；内部请求不得单独制造新的用户轮次。
