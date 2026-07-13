# Viewer Timeline 模型与局部渲染契约

Timeline 已经不再由 `client.js` 一边读取全局状态、一边临时计算筛选结果和窗口。当前边界由纯 View Model 与应用层局部表面共同组成。

## 纯模型

`src/viewer/trace-timeline-model.js` 接收：

- `turns`、`requests`；
- 查询词、状态筛选和结果上限；
- `latestOnly`、活动 Turn、窗口阈值和窗口大小；
- 仅在老数据缺少 Turn 时使用的 request excerpt 回调。

它返回：

- 查询是否生效、各类筛选计数、总命中和当前展示数量；
- 只包含命中 request 证据的 `filteredTurns`；
- Turn Rail 使用的 `railTurns`；
- 中栏使用的 `turnWindow`，包括窗口范围和前后隐藏数量。

该模块不读取 Store，不访问 DOM，不执行网络请求，也不产生本地持久化。异常、慢请求、工具和子 Agent 的分类规则必须在这里保持单一实现。

## 局部渲染表面

`client.js` 当前把应用渲染拆成三个表面：

- Header：标题、统计、会话信息和 Source 导航；
- Timeline：搜索、筛选、Turn 卡片、多 Agent 展示和 Turn Rail；
- Composer：当前 Agent 发送框。

`renderAll()` 只用于 source 初次装载、完整 source 刷新、全局错误状态和 UI/目标翻译语言变化。Timeline 内部的搜索、筛选、分页、Turn 跳转、展开上行、展开回复和多 Agent 面板只调用 `renderTimelineSurface()`，不得重建 Header、Source 导航、Composer 或 Raw Inspector。

翻译单块时：

- Raw Inspector 块只刷新当前 Raw 区块；
- Thinking 块只刷新 Timeline；
- 不允许退回整页 `renderAll()`。

## Store 通知

`ViewerClientStore` 的 `activeId` 和 `activeRequestId` 通知驱动活动 Turn、请求卡片和 Turn Rail 的 DOM 同步。动作函数只写 Store 和处理明确的滚动意图，不再各自复制活动态 querySelector 逻辑。

这仍是阶段性边界：Timeline 的大段 HTML renderer、展开集合和事件装配仍在 `client.js`。后续应在保持本契约的前提下把 renderer/controller 迁入 feature 模块；真正的大 Trace 分页和 normalized entity store 属于阶段 4。

## 回归门禁

- `trace-timeline-model-contract-smoke.mjs` 直接验证筛选、计数、Turn 级回退、结果上限、latest-only、窗口和 lead request。
- `viewer-timeline-surface-contract-smoke.mjs` 锁定局部表面、Timeline 事件作用域和 Store 通知边界。
- `timeline-window-smoke.mjs` 继续覆盖 Timeline、Turn Rail、多 Agent 折叠和容器响应式集成约束。
- 真实浏览器验证必须覆盖 source 切换、搜索/筛选、Turn Rail、Raw tab、回复展开和三栏布局。
