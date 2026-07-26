# 多 Agent 看板 View 契约

更新时间：2026-07-26

多 Agent 看板分成两个无副作用模块：

- `src/viewer/agent-graph-model.js`：按 Turn 选择并稳定排序分支，计算真实显示名、状态、关联证据，以及由稳定 Agent 身份派生的颜色和几何 glyph。
- `src/viewer/agent-graph-renderer.js`：根据显式 View DTO 生成看板摘要、child Agent tabs、一个选中分支的完整时间线容器和关联证据 HTML。

## 边界

两个模块都不得读取全局 `state`、访问 DOM 或发送网络请求。`client.js` 继续负责：

- 从 Client Store 读取看板展开状态和每个 Turn 的选中分支；
- 提供当前 Turn、Trace Domain 已建立的分支图和 request 数据；
- 使用普通 Request Card Model/Renderer 生成选中 child Agent 的完整 request/response timeline，再作为受信任子块交给 Agent Graph Renderer；
- 从主线、幕后时间线和 request rail 中排除已经属于 child 分支的 request id；
- 把 `data-agent-*` 和 `data-request-jump` 动作交给长期存在的 `TraceTimelineController`。

Renderer 不解释 provider 协议，也不自行推断 parent/child。原始 request、response、tool call/result 和关联证据继续来自 Trace Domain 与 Raw Inspector。

## 稳定语义

- 第一行始终是一组 child Agent tabs，一位 child Agent 一个 tab。真实 spawn nickname/分支 label 是主标签，`子1` 等通用编号只能作为辅助信息。
- 默认选择按 `first_request_index` 稳定排序后的第一条分支；用户选择按 Turn 保存，重新渲染不会跳回第一条。
- 颜色和几何 glyph 由 `agent_id`（缺失时再使用稳定 branch id）哈希得到，不依赖显示顺序。颜色不是唯一身份信号，glyph 和昵称同时存在。
- 看板一次只渲染选中 child Agent 的完整有序 request/response timeline，并复用主 Agent 的请求卡、Assistant、Thinking、工具调用和工具结果语言。
- parent spawn、启动回执和结果回流以紧凑关系按钮保留；点击回到对应 request 证据。
- `exec` nested tool dispatch 只有在 semantic 明确命名 `spawn_agent`/`wait_agent` 且完整工具结果提供精确 JSON 时才可闭合分支；nickname、agent id 和终态来自该 JSON，不能从 Assistant 自然语言总结猜测。
- child request 不再同时出现在主 request、幕后 request 或 request rail 中；机制流程仍可保留一条不展开 payload 的因果概括。
- 没有捕获 child 模型请求时，timeline 明确显示空态，但仍保留 spawn、launch、return 与 linkage evidence，不能把未观测请求伪造出来。
- 看板折叠时不生成选中分支的 request-card HTML，避免长 Trace 为不可见内容付出 DOM 和渲染成本。

`scripts/agent-graph-view-contract-smoke.mjs` 直接锁定真实 nickname 优先级、稳定颜色/glyph、tab 选择、单一分支 timeline、关联证据、HTML 转义和无副作用边界。`scripts/timeline-window-smoke.mjs` 锁定 child request 去重与应用装配。真实浏览器回归还需覆盖 tab 切换、分支 request Raw、窄栏横向 tabs 和多主题。
