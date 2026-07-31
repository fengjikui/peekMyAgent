# Turn Rail Client Contract

Turn Rail 是 Viewer Client 拆分出的第一个独立 feature。它只负责右侧 Turn 导航条，不解释 Trace 协议，也不直接修改全局状态。

## 输入边界

`TurnRailController` 通过构造参数接收：

- 当前可导航 Turn 列表与 active id；
- 是否已有可展示 Trace；
- Turn 标题、摘要、国际化和 HTML 转义函数；
- 跳转与 active id 变更回调；
- DOM、主滚动容器和浏览器调度器。

控制器不导入 `client.js`，因此依赖方向始终是应用装配层指向 feature。

## 二级 Request Rail

当当前 Turn 包含至少 5 条主线请求时，中栏标题与 Timeline 之间会显示一条更短、更弱的 Request Rail。它只导航当前 Turn 的请求，不展开整条 Trace 的所有 request。

- Turn Rail 继续表达全局对话轮次，保留主题强调色；
- Request Rail 使用更小的中性色标记，active request 最长、最清晰；
- 顶部位置文案显示请求编号与当前进度，例如 `#38 · 1 / 5`；
- tooltip 显示请求编号和截断后的上行问题；
- 点击刻度滚动到对应请求，并与 Timeline 滚动保持同步；
- 当前 Turn 少于 5 条请求时不显示，避免为普通会话增加视觉噪声。

Request Rail 是当前 Turn 的局部导航，不属于左侧会话树，也不能取代右侧全局 Turn Rail。

## 行为边界

- 根据可用视口高度展示 24 至 72 个 Turn 标记。
- 长 Trace 的窗口围绕 active Turn 移动，并在首尾正确贴边。
- hover 只影响当前标记及相邻三级标记。
- 点击标记通过注入回调请求跳转。
- 主栏滚动使用 `requestAnimationFrame` 合并更新；接近底部时稳定选择最后一个已渲染 Turn。
- 仅当 active id 实际变化时通知应用层，避免重复 render。

## 回归要求

`scripts/turn-rail-contract-smoke.mjs` 锁定窗口、密度、hover 和滚动选择规则；`timeline-window-smoke.mjs` 锁定 `client.js` 的装配关系。涉及 Turn Rail 的修改还必须运行真实浏览器检查，覆盖点击、滚动、resize 与长 Trace 窗口移动。
