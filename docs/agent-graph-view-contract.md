# 多 Agent 看板 View 契约

更新时间：2026-07-19

多 Agent 看板分成两个无副作用模块：

- `src/viewer/agent-graph-model.js`：按 Turn 选择并稳定排序分支，计算状态筛选、分页、颜色、统计和交错事件流。
- `src/viewer/agent-graph-renderer.js`：根据显式 View DTO 生成摘要、单一分支卡、按需筛选、交错时间线和关联证据 HTML。

## 边界

两个模块都不得读取全局 `state`、访问 DOM 或发送网络请求。`client.js` 继续负责：

- 从 Client Store 读取看板展开、筛选、分页和分支展开状态；
- 提供当前 Turn、Trace Domain 已建立的分支图和 request title 解析器；
- 把用户点击交给长期存在的 `TraceTimelineController`；
- 在动作完成后决定何时局部重绘 Timeline。

Renderer 保留现有 `data-agent-*` 属性，它们是 Controller 的稳定交互端口，不是仅供 CSS 使用的实现细节。

## 稳定语义

- 分支编号和颜色按 `first_request_index` 的全量顺序确定；切换状态筛选后不得重新编号。
- 事件流把 spawn、子 Agent 请求/工具事件和 return 按 `request_index` 交错排序，而不是按分支分组伪造执行顺序。
- 默认信息层级只为每个子 Agent 生成一张可展开分支卡，直接标出上下文模式和“启动 -> 确认 -> 回流”证据编号；不再用另一组流程卡重复同一信息。
- 分支摘要中的计数明确称为“已观测子链路事件”，不能把 rollout 生命周期事件误写成模型请求；全部分支类型相同时只在看板摘要显示一次，只有混合类型才在各分支重复标记。
- 折叠态和展开态使用同一条实例摘要。若 Codex 的 `agent_message` 同时就是父级收到的结果回流，View Model 将其标记为同一证据，Renderer 只显示一次“子 Agent 结果回流”，不会再生成内容相同的回复块和回流块。
- 分支卡不重复渲染 adapter 生成的自然语言关联说明；跨 Harness 的关联信号、证据编号和置信度统一放在默认折叠的“关联证据”中，避免每张卡重复且避免硬编码语言渗入英文界面。
- 交错时间线和关联证据完整保留但默认折叠。状态筛选只在分支数超过 6 时出现，避免常见的 2-3 个子 Agent 场景被控制项淹没。
- 分页只限制分支卡数量，不改变筛选总数、状态统计和稳定编号。
- 看板只展示 Trace Domain 提供的关联，不自行猜测新的 parent/child 关系。

`scripts/agent-graph-view-contract-smoke.mjs` 直接锁定这些语义以及 HTML 转义、展开状态和 Controller 数据属性。真实浏览器回归仍需覆盖看板展开、状态筛选、分支展开、事件跳转和“显示更多”。
