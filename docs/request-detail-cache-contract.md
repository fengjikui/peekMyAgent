# Request Detail Cache Contract

Viewer 首屏使用 compact request DTO；只有用户展开上行、Raw、System diff 或翻译相关内容时，才从 `/api/request` 获取完整请求。`src/viewer/request-detail-cache.js` 管理这条按需加载链路。

## 职责

- 判断 compact request 是否缺少详情。
- 按 request id 缓存完整详情、进行中的 Promise 和最近错误。
- 同一请求的并发展开只发送一次 HTTP 请求。
- 失败后清理 in-flight Promise，允许用户重试，同时保留错误供界面展示。
- source 切换时一次性清空详情、Promise 和错误。
- cursor 页面、live tail 或兼容的完整 Trace 刷新合并后，把已缓存详情重新覆盖到 compact DTO。

应用装配层通过 `onLoaded` 在首次成功时合并详情并重建翻译索引，通过 `onCached` 在命中时只合并详情。缓存本身不依赖 DOM、全局 state 或翻译实现。

## 数据兼容

完整详情会清理 `detail_omitted`、`raw.body_omitted` 和 `summary.history_stack_omitted` 标记。合并到当前 Trace 时仍由应用层保留 compact DTO 已计算的 `changes`、`context_delta` 和 context-chain 字段。

## 回归要求

`scripts/request-detail-cache-contract-smoke.mjs` 锁定缺失判定、标记清理、并发去重、首次/缓存回调、错误重试、clear 和数据覆盖。Raw Inspector 的浏览器回归还需验证 compact 首屏、首次打开 loading、成功详情和错误提示。
