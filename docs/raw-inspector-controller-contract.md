# Raw Inspector Controller 契约

更新时间：2026-07-14

本文面向继续维护 Viewer 的编码 Agent，描述 Raw Inspector 的应用生命周期边界。它记录当前实现，不是未来设想。

## 为什么存在这个模块

用户点击请求卡、Raw 标签、System diff、搜索重绘或翻译切换时，都可能要求右栏显示同一个 request 的不同 section。compact Trace 还需要异步补载完整 request。过去这些步骤集中在 `client.js` 的 `showRaw` 中，应用装配、DOM、Store 和竞态判断无法独立验证。

`src/viewer/raw-inspector-controller.js` 将这条稳定流程变成一个显式控制器：

```text
选择 request / section / mode
  -> 重置跨上下文搜索位置
  -> 清理旧翻译动作句柄
  -> 原子写入 ViewerClientStore
  -> 打开 Raw pane
  -> 完整 request 同步提交 content
  -> 或显示 loading 并按需 hydrate request detail
  -> 校验本次操作仍是当前上下文
  -> 提交 content 或 error
  -> 装饰当前搜索命中
```

## 控制器拥有的责任

- 一次 Raw 导航的顺序和生命周期。
- request、section、mode 是否变化的判断。
- loading、content、error 三种提交时机。
- 完整 request 的同步提交，以及 compact request 的异步补载边界。
- 使用递增 `operationId` 取消旧异步提交。
- 使用当前 Store context 防止外部选择变化后的旧提交。
- 当前上下文的无重置刷新。

## 控制器不拥有的责任

- 不解释 Anthropic、OpenAI、OTel 或 Capture DTO。
- 不决定某个 section 包含哪些字段；该语义属于 `raw-view-model.js`。
- 不生成 HTML；HTML 属于 `raw-inspector-renderer.js`、Messages、Translation 和 System diff renderer。
- 不实现搜索和高亮；它只调用 `RawSearchController` 的端口。
- 不读写翻译缓存、不发翻译请求，也不管理翻译材料 hash。
- 不直接调用 Viewer HTTP API。完整 request 的读取由注入的 detail loader 完成。
- 不拥有 pane 几何、localStorage 或全局应用状态。

## 依赖端口

构造函数接收显式端口：

| 端口 | 作用 |
| --- | --- |
| `getRequest` | 从当前 normalized entity store 读取 request |
| `getContext` / `setContext` | 读取并原子更新 `ViewerClientStore` 的 Raw context |
| `onContextChanged` | 仅在 request/section/mode 改变时重置搜索导航 |
| `clearActions` | 清理上一次 Raw 渲染注册的临时翻译动作 |
| `openPanel` | 通知 Pane Layout 打开右栏 |
| `needsDetail` / `loadDetails` | 按 request、section、mode 判断并补载 compact request；System diff 同时考虑前一 request |
| `titleFor` | 由应用层提供双语/方向相关标题 |
| `renderLoading` / `renderContent` / `renderError` | 把显式输入转成 HTML |
| `decorate` | 完成渲染后恢复搜索高亮和当前位置 |
| `canRefresh` | 在 IME 组词等短暂交互临界区拒绝后台同上下文重绘 |

这些端口让控制器可以不启动 daemon、不创建真实网络请求地直接测试。

## 竞态保证

每次 `show()` 都分配新的 `operationId`。异步 detail 返回后，只有同时满足以下条件才允许写 DOM：

1. 它仍是最后一次启动的操作；
2. Store 的 request、section、mode 仍与该操作一致。

因此，先打开 A、再快速打开 B 时，A 的慢响应或错误不会覆盖 B。`invalidate()` 可在 source 生命周期切换等场景主动废弃仍在运行的提交。

已经完整的 request 不得为了复用异步 loader 而额外 `await`：目标区块必须在 `show()` 的同步阶段替换旧内容。否则旧区块的搜索输入会短暂可交互，并在下一次 Promise tick 被替换，破坏中文 IME 组词与焦点。

`refresh()` 属于后台同上下文重绘，必须先经过 `canRefresh()`。当前浏览器装配在 Raw 搜索 IME 组词期间返回 false；选词结束后，搜索控制器会使用最新 request、翻译缓存和 query 主动重绘，所以跳过该次后台刷新不会丢失状态。

## 修改规则

- 新增 Raw section 时，先修改 `raw-view-model.js` 和对应 Renderer，再通过应用装配传给控制器；不要把 section 分支写进控制器。
- 新增网络读取时，扩展 detail/cache service 的端口；不要在控制器中使用 `fetch`。
- 新增翻译动作时，保留在 translation 应用层；控制器最多负责渲染前清理动作句柄。
- 任何异步提交路径都必须经过 `isCurrent()`，不得直接写 `root.innerHTML`。
- 当前上下文的语言、翻译或搜索重绘应使用 `refresh()`；它不得误重置搜索位置。

## 验证

直接契约：

```bash
npm run smoke:raw-inspector-controller-contract
```

该 smoke 覆盖打开面板、完整 request 同步提交、loading、正常 hydrate、快速切换竞态、错误、同上下文刷新、未知 request 和显式失效。集成修改还应运行 Raw Search、Renderer、Client Store、Timeline Controller、静态资源和 dashboard smoke，并在重要 Viewer 批次后执行真实浏览器检查。
