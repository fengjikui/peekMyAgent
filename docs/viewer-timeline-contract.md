# Viewer Timeline 模型、渲染与控制器契约

Timeline 已经不再由 `client.js` 一边读取全局状态、一边临时计算筛选结果、窗口和 DOM 事件。当前边界由纯 View Model、纯 Renderer、长生命周期 Controller 与应用装配层共同组成。

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

## Renderer

`src/viewer/trace-timeline-renderer.js` 只接收显式 DTO 和依赖，负责：

- 查询框、筛选项、命中计数和“继续显示”；
- 无结果与空 Trace 状态；
- 长 Trace 窗口前后边界；
- Turn window、request map 与应用层 `renderTurnGroup` 的编排。

Renderer 不读取 Store、全局 `state` 或 DOM，不注册事件，也不决定 Raw/Agent 动作。Turn request、Assistant response 和多 Agent 卡片仍由应用层 renderer 生成，这是下一批可独立迁移的边界。

## Controller

`src/viewer/trace-timeline-controller.js` 长期持有查询栏和 Timeline 根节点。它只在初始化时绑定一次监听器，通过事件委派识别 `data-*` 动作并调用注入端口，不在每次 `innerHTML` 更新后重新扫描和绑定每个按钮。

Controller 负责：

- 中文、日文等 IME composition 生命周期与延迟搜索刷新；
- filter/show-more、Raw、窗口跳转、Agent 分支、System diff 等动作分发；
- `<details>` 上行展开状态回调；
- 活动 Turn/request 的局部 DOM class 同步。

Controller 不拥有业务状态，不发网络请求，不解释 Trace DTO。筛选后选择哪个 Turn、分支展开集合、Raw section 和实际重绘仍由 `client.js` 注入的动作完成。

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

`ViewerClientStore` 的 `activeId` 和 `activeRequestId` 通知驱动活动 Turn、请求卡片和 Turn Rail 的 DOM 同步。Timeline class 同步由 Controller 在自己的根节点内完成；动作函数只写 Store 和处理明确的滚动意图，不再各自复制活动态 querySelector 逻辑。

这仍是阶段性边界：Turn request、Assistant response、多 Agent graph 的领域 renderer，以及展开集合和动作实现仍在 `client.js`。后续应保持 model/renderer/controller 的单向依赖，逐个迁移这些领域卡片；真正的大 Trace 分页和 normalized entity store 属于阶段 4。

## 回归门禁

- `trace-timeline-model-contract-smoke.mjs` 直接验证筛选、计数、Turn 级回退、结果上限、latest-only、窗口和 lead request。
- `trace-timeline-renderer-contract-smoke.mjs` 直接验证查询 HTML、转义、空状态、窗口边界和旧 Trace fallback。
- `trace-timeline-controller-contract-smoke.mjs` 模拟 IME、延迟刷新、单次事件委派、Raw/Agent 动作和活动态同步。
- `viewer-timeline-surface-contract-smoke.mjs` 锁定应用装配、局部表面、Controller 归属和 Store 通知边界。
- `timeline-window-smoke.mjs` 继续覆盖 Timeline、Turn Rail、多 Agent 折叠和容器响应式集成约束。
- 真实浏览器验证必须覆盖 source 切换、搜索/筛选、Turn Rail、Raw tab、回复展开和三栏布局。
