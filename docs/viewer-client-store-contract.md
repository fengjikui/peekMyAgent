# Viewer Client Store 契约

`src/viewer/client-store.js` 是 Viewer 浏览器端的最小状态所有权边界。它不是通用状态管理框架，也不负责渲染；当前目的，是先把跨 feature 共享、会影响 URL/布局/Raw Inspector 的核心状态从 `client.js` 的任意直接赋值中收拢出来。

## 当前所有权

Store 只管理以下可序列化状态：

- source、Turn 和 request 选择：`activeSourceId`、`activeId`、`activeRequestId`；
- Raw Inspector：`activeRawSection`、`activeRawMode`、`rawMessagesMode`；
- 语言与翻译视图：`uiLanguage`、`targetTranslationLanguage`、`translationMode`；
- 三栏布局：`rawOpen`、`rawWidth`、`sidebarOpen`、`sidebarWidth`；
- 时间线偏好：`latestOnly`。

`client.js` 仍负责网络请求、DOM、`localStorage`、定时器、缓存实例、展开集合和 feature 生命周期。现阶段通过同一 `state` 引用兼容旧读取路径，但上述受管字段只能通过 Store 方法写入。其余状态会在对应 feature 拆分时逐步迁移，不应为追求形式统一一次性塞入 Store。

## 更新语义

- `update()` 接收一个 patch，并在全部字段更新后最多通知一次。
- 领域方法 `setSelection()`、`setRawView()`、`setLanguage()`、`setLayout()`、`setTimeline()` 只能修改自己拥有的字段。
- `setRawContext()` 将活动 request、Raw section 和请求/响应模式作为一个原子动作更新。
- 值未变化时不通知订阅者，避免后续局部 renderer 重复工作。
- 通知包含 `changedKeys`、旧值 `previous`、动作 `reason` 和只读 snapshot；订阅者不需要重新比较整个应用状态。
- 初始化读取浏览器偏好时允许 `silent` hydration，持久化本身仍由应用层负责。

Store 不调用 `renderAll()`，不访问 `window`、`document`、`fetch` 或 `localStorage`。后续 feature 应根据 `changedKeys` 订阅自己拥有的视图更新，而不是把 Store 变成新的全局副作用中心。

## 回归要求

`scripts/viewer-client-store-contract-smoke.mjs` 锁定默认值、原子通知、幂等更新、领域隔离、取消订阅和 Raw context 更新，并静态检查 `client.js` 不得直接赋值受管字段。

真实浏览器回归仍需覆盖：source/Turn/request 导航、Raw tab、原文/翻译切换、latest-only，以及左右栏折叠和拖拽。Store 契约只证明状态边界，不替代 DOM 和交互验证。
