# Raw 搜索真实浏览器契约

更新时间：2026-07-15

Raw Inspector 的搜索同时涉及完整 JSON 值、截断摘要、中文输入法、DOM 高亮、滚动和区块切换。纯模型或伪 DOM 测试不能证明这些行为在真实浏览器中协作正确，因此发布门禁包含一条不依赖外部账号或模型服务的 Chromium/Edge 场景。

## 产品语义

- 过滤检查条目的完整路径和完整值，不以 420 字符摘要作为匹配边界。
- 结果摘要围绕完整值中的真实命中位置生成；关键词在长文本尾部时也必须可见。
- 计数表示当前结果区实际可见的关键词出现次数，而不是匹配条目数。
- 上一个和下一个逐个可见命中循环导航，始终只有一个 active mark 和一个 active result。
- 中文、日文、韩文等 IME 组词期间不得替换输入框；`compositionend` 后才重绘结果。
- request 已完整时，Raw 区块同步切换；翻译缓存等后台刷新在 IME 组词期间跳过，不能以异步提交替换输入框。
- 切换 Raw 区块时保留查询，并按新范围重新建立可见结果。
- Raw 分类、搜索和翻译控制区在右栏滚动时保持粘性。

## 自动化场景

`scripts/raw-search-browser-smoke.mjs` 会在临时目录中：

1. 启动隔离 Viewer、SQLite Store 和 mock Anthropic upstream；
2. 通过真实 Capture Proxy 保存含 12 段长 System 文本的请求；
3. 启动本机 Chrome、Chromium 或 Edge 的 headless DevTools 会话；
4. 在真实 Viewer 中打开 System，模拟中文 IME 输入；
5. 验证 13 个长文本命中、前后循环跳转、活动高亮和焦点；
6. 滚动 Raw 面板并验证粘性控件；
7. 切换 Tools/System 并验证查询和结果恢复；
8. 拒绝任何浏览器运行时异常，随后清理浏览器 profile、watch、进程和临时数据。

浏览器由 `scripts/lib/chromium-cdp.mjs` 跨平台发现。需要覆盖默认发现路径时，设置：

```bash
PEEKMYAGENT_BROWSER_PATH=/absolute/path/to/chrome npm run smoke:raw-search-browser
```

测试只访问临时 loopback 服务，不需要 Claude Code、OpenClaw、API key 或互联网连接。

## 修改规则

- `collectRawSearchEntries()` 可以保留短预览用于非搜索展示，但 Renderer 的命中摘要必须基于完整 `entry.value`。
- 搜索计数、导航和 active 状态以浏览器中可见的 `mark` 为事实源；关闭的 `<details>` 内命中不参与计数。
- 修改搜索输入、摘要、高亮、Raw 区块导航或粘性布局时，必须同时运行纯模型、Controller、Renderer 和本浏览器 smoke。
- 浏览器驱动不得依赖仓库外 npm 包；Node 24 的内置 `fetch`、`WebSocket` 和 CDP 足以完成该场景。
- 新增浏览器路径时必须保持 macOS、Windows 和 Linux 发现逻辑集中在 `scripts/lib/chromium-cdp.mjs`。

## 验证

```bash
npm run smoke:raw-search-model-contract
npm run smoke:raw-search-controller-contract
npm run smoke:raw-inspector-renderer-contract
npm run smoke:raw-search-browser
```

`npm run release:check:*` 会在对应平台运行以上场景。宿主机必须安装 Chrome、Chromium 或 Edge；无法使用默认路径时通过 `PEEKMYAGENT_BROWSER_PATH` 指定可执行文件。
