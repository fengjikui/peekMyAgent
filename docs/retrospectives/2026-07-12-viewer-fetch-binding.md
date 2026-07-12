# Viewer API Client fetch 绑定回归复盘

## 现象

重构 `ViewerApiClient` 后，`/api/sources` 直接访问仍返回两条真实轨迹，但浏览器左栏和时间线为空。刷新无法恢复。

浏览器控制台错误：

```text
TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation
```

## 根因

API Client 构造时把 `window.fetch` 保存到实例字段，随后以普通函数调用。浏览器的原生 `fetch` 需要合法的 Window 调用上下文；Node 测试使用的 fake fetch 没有该约束，因此原有契约测试和 HTTP smoke 均未发现问题。

## 修复

- `ViewerApiClient` 显式把 `fetchImpl` 绑定到可注入的 `fetchContext`，浏览器默认绑定 `globalThis`。
- API Client 契约测试使用依赖 `this` 的 fake fetch，锁定调用上下文。
- 不修改 source 数据、SQLite 或 Viewer API；真实数据始终保留在 `~/.peekmyagent/store.sqlite`。

## 验证

- 直接 API：`/api/sources` 返回 2 条真实 source。
- 契约：`smoke:viewer-api-client-contract` 验证 fetch context、URL、method、intent 和错误传播。
- 浏览器：必须确认左栏出现真实 source、可打开已有 Trace、可切换 Raw 区块且控制台无错误。

## 流程改进

Viewer 代码变动不能只依赖静态 source smoke、HTTP API 或 Node fake DOM。每个 Viewer 里程碑提交前必须执行一次真实浏览器 smoke：加载 source 列表、打开已有 Trace、操作本次变更相关控件、检查可见结果和 console error。
