# Viewer Pane Layout Controller 契约

更新时间：2026-07-14

## 目标

三栏布局同时涉及持久状态、DOM 生命周期、浏览器输入事件和宽度几何。该契约把这些责任分开，避免 `client.js` 再次成为布局状态、拖动实现和偏好存储的共同所有者。

## 所有权

| 边界 | 所有内容 | 禁止内容 |
| --- | --- | --- |
| `ViewerClientStore` | `rawOpen`、`rawWidth`、`sidebarOpen`、`sidebarWidth` | DOM、CSS、`localStorage` |
| `pane-layout-model.js` | 宽度上下限、最大可用宽度、内容区宽度和面板占比 | DOM、浏览器全局对象、Store |
| `PaneLayoutController` | 折叠、CSS 变量、ARIA、键盘/鼠标/指针事件、窗口变化和布局偏好 | 网络请求、领域数据、全局 `state` |
| `client.js` | 注入 Store 写入、UI 文案、Turn Rail 和窗口重绘端口 | 重复实现布局算法或 resizer 生命周期 |

## 持久状态

Controller 读取和写入以下浏览器偏好：

```text
peekmyagent.rawOpen
peekmyagent.rawWidth
peekmyagent.sidebarOpen
peekmyagent.sidebarWidth
```

初始化时，应用层先调用 `readPreferences()`，再把结果一次性写入 Store，最后调用 `applyCurrentState({ persist: false })` 同步 DOM。偏好恢复不能绕过 Store，也不能在初始化时把相同值重新写回存储。

## 几何不变量

- Raw 宽度范围为 320-760px，左栏为 220-420px，中栏至少保留 520px。
- 两个 6px resizer 仅在对应面板打开时计入可用空间。
- 所有宽度入口最终调用纯 Model 的 clamp；窗口缩小时不能让已保存宽度挤掉中栏最小空间。
- 折叠或打开左栏时，Raw 栏尽量保持其在“中栏 + Raw 栏”内容区中的占比，而不是固定占用旧像素宽度。
- Raw 或左栏宽度变化必须同步 CSS 变量和 resizer 的 `aria-valuenow/min/max`。

## 交互生命周期

- `bind()` 幂等；同一个 Controller 只能注册一组监听器。
- Pointer、mouse fallback 和 keyboard 共享 `setRawWidth()` / `setSidebarWidth()`。
- 普通方向键每次调整 24px，按住 Shift 时调整 80px。
- 1080px 及以下视口禁用拖动，保持现有紧凑布局行为。
- 拖动期间只更新内存和 DOM，结束时才持久化最终宽度。
- `destroy()` 必须移除全部已注册监听器和拖动态 class，供测试、热重载或未来页面生命周期使用。
- UI 语言变化必须调用 `refreshLabels()`，保证折叠按钮的 title 与当前语言一致。

## 应用端口

Controller 只通过构造参数访问外部能力：

- `getLayoutState()`：读取 Store 当前布局快照。
- `setLayout(patch, options)`：通过 Store 写入布局状态。
- `translate(key)`：读取当前 UI 文案。
- `onLayoutChanged()`：通知 Turn Rail 重新同步活动位置。
- `onWindowResize()`：通知应用重绘依赖视口的 Turn Rail。

新增布局副作用时，应优先扩展显式端口；不得从 Controller 导入 API client、Trace DTO 或应用全局状态。

## 验证

直接契约测试：

```bash
npm run smoke:pane-layout-controller-contract
```

测试覆盖纯几何边界、偏好恢复、折叠比例、ARIA/CSS 同步、幂等绑定、键盘调整、指针拖动、窗口变化和监听器清理。发布前还必须在真实浏览器验证三栏折叠/展开、拖动、方向键、语言切换和控制台错误。
