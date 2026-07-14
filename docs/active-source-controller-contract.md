# Active Source Controller 契约

更新时间：2026-07-15

本文描述 Viewer 从 Source 清单选择一条 Trace，到首屏、后台分页、翻译缓存和 live refresh 可见提交的应用级生命周期。它记录当前实现，不是未来设想。

## 两层 Source 控制器

Source 加载被刻意分为两层：

```text
client.js DOM / Store / UI ports
  -> ActiveSourceController 应用编排
    -> SourceTimelineController 数据状态机
      -> TimelineEntityStore / ViewerApiClient
```

`SourceTimelineController` 独占 generation、cursor、progressive busy/error 和 normalized entity store。`ActiveSourceController` 不解析 cursor，也不创建第二份 Timeline store；它只根据底层返回的 opaque token 编排用户可见副作用。

## 控制器拥有的责任

- 初始化 Source 清单，并按 URL 请求值、可用状态和列表顺序选择首个 Source。
- Source 切换时决定是否渐进加载，并在真正跨 Source 时触发 source-scoped UI 失效端口。
- 首屏提交后在后台续读 cursor page；每页保留用户滚动位置，完成后加载当前数据的翻译缓存。
- 持有自动刷新 timer 和 single-flight 标记；隐藏页面不轮询。
- 对 Source 清单计算稳定签名，只在导航信息变化时要求重绘。
- 对 active Source 的请求/回复计数、live 状态和时间戳变化决定是否 refresh。
- 对刷新前后 Timeline snapshot 计算可见数据签名；无可见变化时只同步数据，不重绘。
- 在翻译 await 之后再次校验 timeline token 和 active Source，拒绝旧 Source 的迟到 UI 提交。
- 通过 `catalogVersion` 拒绝晚于导入、归档、删除等 mutation response 返回的旧 Source 清单。

## 控制器不拥有的责任

- 不访问 DOM、`window`、`history`、`localStorage` 或 `fetch`。
- 不读写活动 Turn/request，不计算选择回退或 URL。
- 不拥有翻译 cache/provider/HTML；只调用注入的 snapshot-based 翻译端口。
- 不处理 prompt、confirm、alert、文件导入导出或菜单文案。
- 不解释 Capture、provider、Turn 或子 Agent 语义。
- 不维护 cursor、refresh cursor、generation 或 `TimelineEntityStore`。

## 主要端口

| 端口 | 当前用途 |
| --- | --- |
| `timeline` | 委托首屏、cursor、refresh、snapshot 与 token 校验 |
| `listSources()` | 获取 Source 清单；URL 和 HTTP 仍由 `ViewerApiClient` 所有 |
| `getContext()` / `setSources()` / `setData()` | 读取应用上下文并同步兼容展示镜像 |
| `resetSourceContext()` | 失效 Raw、详情、翻译 operation 和 Source-scoped 展开状态 |
| `captureScroll()` | 获取主栏 scrollTop 与 near-bottom 状态 |
| `presentLoadedData()` | 提交普通/渐进 page 的 selection、URL、render 与滚动 |
| `presentRefreshedData()` | 提交 live refresh 的 selection、render 与滚动 |
| `loadTranslations(data)` | 为显式 Timeline snapshot 加载当前目标语言缓存 |
| `refreshRaw()` / `renderData()` | 刷新可见 Raw 或 progressive error |
| clock / visibility / warning ports | 确定性 timer、后台暂停与日志出口 |

## 竞态保证

1. 底层旧首屏、旧 cursor 和旧 refresh 先由 `SourceTimelineController` generation 拒绝。
2. 首屏和每个后台 page 只有在底层提交成功后才进入 UI 端口。
3. 翻译使用显式 data snapshot；翻译完成后必须再次满足 `timeline.isCurrent(token, sourceId)`。
4. refresh 在翻译期间切换 Source 时，旧 refresh 不得恢复 selection、滚动、Timeline 或 Raw。
5. 当前 Source 的翻译缓存读取失败只记录 warning；新 Timeline 数据仍必须可见提交。
6. 轮询 Source 清单开始后若发生导入、归档、删除或停止监听，mutation 通过 `acceptSources()` 增加 catalog version；迟到轮询结果被丢弃。
7. 自动刷新始终 single-flight；页面隐藏或底层 Timeline 正忙时不产生额外可见提交。

## `client.js` 保留的 UI 行为

- 写入 `state.data` 兼容展示镜像和 `ViewerClientStore` selection。
- 更新 URL、渲染三栏、恢复滚动和同步 Turn Rail。
- 判断 Raw 是否已打开并刷新当前 request。
- Source 切换时清理 Raw、Request Detail、Translation operation、查询和 Agent 展开状态。
- 导入导出、Source/项目菜单、watch stop 的浏览器交互和 API 错误提示。

## 修改规则

- 不得把 cursor、generation 或 normalized entity 合并逻辑加入本控制器。
- 新的异步阶段必须在 await 后复核底层 token；网络取消不能替代状态校验。
- Server mutation 返回的 Source 清单必须经 `acceptSources()`，不得直接覆盖应用清单。
- 新增 UI 副作用应作为端口留在装配层，不应在控制器中引用 DOM。
- Source 生命周期变化必须同步本文、`source-timeline-controller-contract.md`、架构图和直接 smoke。

## 验证

```bash
npm run smoke:active-source-controller-contract
```

该契约覆盖首选 Source、渐进首屏/后台 page、跨 Source reset、滚动保留、翻译与 Raw 时序、refresh 变化判定、翻译期间切换的旧提交拒绝、隐藏页面、timer 幂等和旧 Source 清单拒绝。
