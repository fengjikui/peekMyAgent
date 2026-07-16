# Raw Inspector Renderer 契约

`src/viewer/raw-inspector-renderer.js` 是无状态 HTML renderer。调用方必须显式传入 request、active section、query、match count、翻译函数、HTML 转义函数以及 JSON/摘要 renderer。

## 方向约束

- 请求导航只包含完整请求、System、System diff、Tools、Harness、Messages、本次上行 `tool_use`、回传 `tool_result` 和 Metadata。
- Response 导航独立显示 Response 与本次响应 `tool_use`。
- Assistant 侧的 Tools schema 位于“上行参考”组，不宣称来自 response body。
- 完整请求在首位，Metadata 在请求导航末位。

## 渲染边界

- renderer 不读取 Viewer 全局 state、翻译缓存或 request-detail cache。
- renderer 不决定当前 request，也不发起网络请求。
- 所有动态文本经调用方 `escapeHtml`；JSON、pre 和关键词摘要由已验证的专用 renderer 注入。
- 搜索 controller 继续拥有 query、IME、active index、DOM mark 与滚动。

## 验证

```bash
npm run smoke:raw-inspector-renderer-contract
npm run smoke:viewer-static-assets-contract
```

契约覆盖请求/响应导航分离、条件工具区块、搜索工具条与结果、来源提示、loading/error 和动态文本转义。真实浏览器验证负责 request/response tab 切换、粘性区、搜索高亮与可见布局。
