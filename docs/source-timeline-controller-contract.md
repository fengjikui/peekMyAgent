# Source Timeline Controller 契约

更新时间：2026-07-14

本文面向继续维护 Viewer 的编码 Agent，描述 Source 数据加载与 Timeline normalized state 的当前边界。它记录已经实现的行为，不是未来设想。

## 为什么存在这个模块

Viewer 打开一个 Source 时可能经历首屏 compact 读取、后台 cursor 续读、live refresh cursor、过期 cursor 全量回建，以及单条 request 详情补载。过去这些流程直接由 `client.js` 维护 `sourceLoadSeq`、`TimelineEntityStore` 和若干异步函数，数据一致性与 DOM 副作用纠缠在一起。

`src/viewer/source-timeline-controller.js` 把 Source 数据生命周期变成显式状态机：

```text
选择 Source
  -> 分配 generation token
  -> 读取完整 compact 或首屏 page
  -> 建立 TimelineEntityStore
  -> 覆盖已缓存 request detail
  -> 提交首屏 snapshot
  -> 按 cursor 逐页续读并提交 snapshot
  -> 到达尾部后保留 refresh cursor

live Source 变化
  -> 若首屏/续读仍在进行则跳过本次 refresh
  -> 在临时 Store 上应用 refresh cursor
  -> cursor 过期时从首屏重新构建
  -> 原子替换当前 Store
```

## 控制器拥有的责任

- 当前 Source generation、目标 Source 和已提交 Source identity。
- 当前 `TimelineEntityStore` 及其 normalized request、Turn、Agent entity。
- 大 Trace 首屏读取、cursor 续读、live refresh 和过期回建的顺序。
- progressive loading、refresh busy 和 progressive error 状态。
- 使用 generation token 拒绝旧 Source、旧 cursor 和旧 refresh 的迟到结果。
- compact page 与 `RequestDetailCache` 已有详情的覆盖合并。
- request detail 在刷新期间完成时，刷新提交前重新覆盖最新详情。

## 控制器不拥有的责任

- 不读取或修改 DOM，不决定滚动位置、活动 Turn 或活动 request。
- 不读写 URL、history、`localStorage` 或左侧 Source 菜单。
- 不加载翻译缓存，不决定翻译目标语言，也不重绘 Raw Inspector。
- 不创建 HTTP URL；网络端口由 `ViewerApiClient` 注入。
- 不解释 Capture、provider 或 provenance 语义；它只消费 Viewer Timeline DTO。
- 不计算 Timeline 查询、窗口、请求卡或多 Agent HTML。
- 不拥有完整 request 的网络缓存；`RequestDetailCache` 仍负责并发去重、错误和 source 级清理。

## 依赖端口

| 端口 | 作用 |
| --- | --- |
| `loadView(sourceId, options)` | 读取完整 compact、首屏或 cursor page；浏览器装配到 `ViewerApiClient.viewSource` |
| `detailFor(requestId)` | 查询 `RequestDetailCache` 中已经补载的完整 request |
| `yieldControl()` | cursor 页面之间让出主线程；浏览器装配为短 `setTimeout` |
| `onWarning(message, error)` | 报告 refresh cursor 失效并回建，不把日志机制写进控制器 |
| `initialLimit` / `cursorLimit` | 首屏和后续页尺寸 |
| `progressiveThreshold` | Source 进入渐进加载的 request 数门限 |

## Generation 与竞态保证

每次 `loadSource()` 都启动新的 generation。异步结果只有满足以下条件才能提交：

1. token 仍是当前 generation；
2. target source 仍等于操作 source；
3. cursor/refresh 阶段的 committed source 和 Store source 也一致。

因此：

- 先点击 A、再点击 B 时，A 的慢首屏不能覆盖 B。
- A 的 cursor 已发出后切换到 B，迟到 page 不会触发 `onPage`。
- 大 Trace 后台续读期间，自动 refresh 会跳过本次周期，避免两个写入者同时修改 Store。
- refresh 在临时 Store 上完成，只有整条增量或回建成功后才原子替换当前 Store。
- refresh 网络请求期间补载的完整 request 会在提交前再次覆盖，不会退化回 compact preview。

## 应用层装配

`ActiveSourceController` 负责首屏、后台 page、翻译和 live refresh 的应用顺序，但不拥有下列用户可见副作用；这些行为仍由 `client.js` 通过端口提供：

- Source 切换时清理 Raw、详情缓存和中栏展开状态。
- 把控制器 snapshot 写入 `ViewerClientStore` 的选择上下文。
- 更新 URL、渲染三栏、恢复滚动位置和同步 Turn Rail。
- 完整 Source 加载后读取翻译缓存并刷新 Raw。
- 根据数据签名决定 live refresh 是否需要重绘。

不要把上述 DOM/UI 行为反向加入任一 Source 控制器。反过来，也不要在 `client.js` 或 `ActiveSourceController` 重新维护 cursor、generation 或第二份 `TimelineEntityStore`。应用编排的详细契约见 [Active Source Controller 契约](active-source-controller-contract.md)。

## 修改规则

- 新增 Timeline wire entity 时，先扩展 `TimelineEntityStore` 与分页协议，再由控制器复用；不要在控制器里维护平行数组。
- 新增 abort signal 时，应作为 `loadView` 端口能力并保持 generation 校验；网络取消不能替代状态一致性校验。
- 修改渐进加载门限时，保留构造参数和契约测试，不要把数字散落到 UI 分支。
- 修改详情缓存时，必须保留首屏、page 和 refresh 提交前的 detail overlay。
- `refreshSource()` 不得在首屏或 progressive cursor 工作期间并发写 Store。
- Source/Timeline 数据行为变化必须同步本文、`architecture.md`、`codebase-map.md` 和确定性 smoke。

## 验证

直接契约：

```bash
npm run smoke:source-timeline-controller-contract
```

该 smoke 覆盖渐进首屏、详情覆盖、cursor 续读、旧首屏/旧 page 失效、错误状态、refresh cursor、cursor 失效回建、小/大 Source refresh、忙碌保护，以及刷新期间详情补载。集成修改还应运行 Timeline Entity Store、Request Detail Cache、Viewer Static Assets、Package 和真实浏览器长 Trace 检查。
