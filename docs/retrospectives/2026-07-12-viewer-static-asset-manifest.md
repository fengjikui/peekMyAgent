# Viewer 模块静态资源漏注册复盘

## 现象

Raw Search Model 的 Node 契约、package smoke 和 Dashboard HTTP smoke 均通过，但真实浏览器刷新后只显示页面外壳：没有会话列表，也没有 Trace 内容。

直接请求新模块得到：

```text
GET /raw-search-model.js -> 404 Not Found
```

## 根因

Viewer 使用原生浏览器 ESM。`client.js` 新增相对 import 后，npm 包虽然包含文件，daemon 的静态资源路由仍是逐文件 `if` 白名单；新增模块未同步注册，因此浏览器无法完成模块图加载。已有 `dashboard-open` 只验证 daemon 生命周期和一个共享 translation contract，没有验证 `client.js` 的全部 import。

## 修复

- 新增 `src/server/viewer-static-assets.mjs`，集中声明受控静态资源、文件位置和 content type。
- `server.mjs` 只解析 manifest 命中项，未注册路径继续返回 404，不扩大本机服务暴露面。
- `smoke:viewer-static-assets-contract` 解析 `client.js` 的相对 import，逐一验证白名单、文件存在和 JavaScript content type。
- package smoke 把真正影响用户下载成本的压缩/解压体积作为主要约束，并保留防止误打包仓库的文件总数上限。

## 验证

- `/raw-search-model.js` 返回模块源码。
- 两条真实旧 Trace 正常出现。
- System 中文视图搜索 `Claude` 得到 38 个可见命中；下一条与上一条在 `1/38`、`2/38` 间正确导航。
- 浏览器控制台无 error 或 warning。
- Raw Search、静态资源、Dashboard、Viewer HTTP、package、release manifest 与 governance smoke 全部通过。

## 后续约束

新增 Viewer 浏览器模块时，必须同时满足三层证据：模块纯契约、静态资源 manifest 契约、与改动范围匹配的真实浏览器操作。小型纯函数抽取可以累计后再跑完整发布门禁，但不能省略对应的窄范围浏览器验证。
