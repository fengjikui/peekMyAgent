# Viewer HTTP 边界

更新时间：2026-07-12

`src/server/http.mjs` 是 Viewer/daemon 的 HTTP 传输与本机安全边界。它不读取 Trace、不访问 SQLite、不理解翻译或 Agent 业务，只负责把不可信 HTTP 输入变成经过约束的请求，或形成统一响应。

## 所有权

该模块负责：

- API method 表与 `405 Allow` 响应；
- loopback Host、Origin/Referer、Fetch Metadata 校验；
- 状态变更请求的 Content-Type 限制；
- `x-peekmyagent-intent` 显式意图校验；
- JSON/raw body 大小上限与解析；
- JSON、静态文件响应和统一 CSP/安全响应头；
- 非 loopback bind 的默认拒绝。

该模块不负责：

- 路由注册和业务参数校验；
- watch/source/capture 生命周期；
- Trace import 内容格式、脱敏、provenance 或持久化；
- Viewer DTO 和领域解释。

## 校验顺序

请求进入 `handleRequest` 后遵循固定顺序：

1. `validateLocalHttpRequest` 校验网络和浏览器来源边界。
2. route 用 `rejectWrongMethod` 产生明确的 `405`；已知错误 method 不应先被 Content-Type 误判成 `415`。
3. 状态变更 route 校验专用 intent。
4. 业务函数读取有大小限制的 body 并校验领域字段。
5. 错误由 server 门面统一序列化，响应始终带 Viewer 安全头。

这个顺序属于对外行为，后续 route registry 或框架替换不得无测试地改变。

## 扩展规则

新增 API 时必须：

1. 在 `API_METHODS` 增加 method；
2. 若会改变状态，定义明确 intent，不复用含义不同的 intent；
3. 默认只接受 JSON，二进制类型必须像 Trace import 一样显式收窄；
4. 在 `viewer-http-contract-smoke` 覆盖纯边界，在 `security-boundary-smoke` 覆盖真实 server；
5. 不把业务 repository 或 service 依赖引入 `http.mjs`。
