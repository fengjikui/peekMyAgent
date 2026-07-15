# Viewer Router 契约

更新时间：2026-07-15

本文记录 Viewer HTTP 传输层的当前事实。路由表和 ID/分页上限的可执行事实源是 `src/contracts/viewer-api.mjs`，路由实现位于 `src/server/viewer-router.mjs`，运行时依赖由 `src/viewer/server.mjs` 组装。Source 与单请求响应的字段边界见 [Viewer API DTO 契约](viewer-api-dto-contract.md)。

## 所有权

`ViewerRouter` 只拥有 HTTP 语义：

- URL、query、method 和显式 intent 校验；
- JSON/Raw body 读取和大小上限；
- 静态资源优先分发；
- JSON、gzip Trace bundle 和状态码响应；
- `/api/view` 的 full/compact/cursor 表示选择；
- daemon shutdown 必须等响应 `finish` 后触发。

它不拥有 Source、watch、翻译、Trace import/export、OTel、Agent send、Timeline 或请求详情的业务实现。这些能力由 `createViewerRouter()` 的 `operations` 端口显式注入。

## 固定处理顺序

每个请求必须按以下顺序处理：

1. `validateLocalHttpRequest`：loopback Host、Origin/Referer、Fetch Metadata 和 state-changing Content-Type；
2. 静态资源解析与发送；
3. 路由是否存在；
4. route method 校验，错误返回 `405` 和 `Allow`；
5. route intent 校验，缺失或错误返回 `403`；
6. body 解析、query 规范化和 operation 调用；
7. 序列化响应。

这个顺序是安全和兼容契约。例如已知 API 使用错误 method 时必须先得到 `405`，不能因为 POST 没有 Content-Type 提前得到 `415`。

## 依赖端口

Router 构造时会校验以下 operations 全部存在：

```text
listSources             loadTranslations       generateTranslations
startWatch              stopWatch              pauseWatch
sendAgentMessage        updateSource           importTrace
exportTrace             ingestOtelCaptures     ingestOtelEvents
listWatchStatus         daemonPing             daemonStatus
requestShutdown         loadViewerData         startTimeline
nextTimeline            loadRequestDetail
```

业务 operation 接收已解析的对象或 Buffer，不接收 Node `IncomingMessage`/`ServerResponse`。静态资源通过独立的 `resolve`/`serve` 端口注入，因此 Router contract smoke 不需要启动 daemon 或访问文件系统。

## 共享 API 事实源

`src/contracts/viewer-api.mjs` 统一定义：

- 全部 Viewer API pathname 和 method；
- source/request/cursor ID 长度限制；
- 首屏请求数量默认值和最大值；
- API lookup ID 的控制字符清洗与有界截断。

`src/server/http.mjs` 和 `ViewerRouter` 都读取这份契约，避免安全预检方法表与实际路由分叉。新增或删除 API 时必须同时更新共享路由表、Router handler、浏览器 `api-client.js`（若面向 UI）和契约测试。

## 验证

```bash
npm run smoke:viewer-http-contract
npm run smoke:viewer-router-contract
npm run smoke:security-boundary
```

`viewer-router-contract` 不启动网络服务，覆盖全部路由、method/intent、静态资源、OTel header、分页参数、Trace 二进制响应和 shutdown 时序。`security-boundary` 启动真实 Viewer Server，负责锁定最终 HTTP 行为。
