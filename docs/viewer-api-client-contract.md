# Viewer API Client Contract

`src/viewer/api-client.js` 是浏览器与本地 Viewer Server 之间的唯一 HTTP 协议门面。Feature renderer 不应自行拼接 `/api/*` URL、intent header 或错误响应。

## 职责

- 统一 source 列表、compact view、request detail 和翻译缓存读取。
- 统一翻译生成、source 操作、Agent send 与 watch stop 的 JSON POST 协议。
- 统一 Trace 导入的二进制 body、文件名和 intent header。
- 保留 Trace 导出的原始 `Response`，由应用层决定下载文件名和 Blob 生命周期。
- 将 JSON 或文本错误响应转换为一致的 `Error`。
- 绑定浏览器 `fetch` 的执行上下文，避免解构或保存方法后触发 `Illegal invocation`。

API Client 不持有 source、request、translation 或布局状态，也不操作 DOM。这样 request-detail cache、Raw Inspector 和其他 feature 可以共享协议层，而不依赖 `client.js` 的全局实现。

## 安全边界

会产生本地副作用的接口必须在这里声明准确的 `x-peekmyagent-intent`。Server 仍是最终校验者；Client 不能削弱 loopback、Origin、Fetch Metadata、Content-Type 或 method 检查。

## 回归要求

`scripts/viewer-api-client-contract-smoke.mjs` 锁定 URL 编码、compact/initial 参数、HTTP method、Content-Type、intent、二进制导入、原始导出响应和错误传播。新增 Viewer API 时，应先扩展该契约，再由 feature 调用命名方法。
