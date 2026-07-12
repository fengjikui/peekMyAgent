# Raw Search Model 契约

`src/viewer/raw-search-model.js` 是 Raw Inspector 的纯搜索语义层。它不读取全局 Viewer state，不操作 DOM，也不生成带业务文案的 HTML。

`src/viewer/raw-search-controller.js` 在此模型之上拥有浏览器交互状态：query、IME composition、active index、延迟重绘、清空、可见 mark 与滚动。`client.js` 只注入当前 request/section/mode 和 `showRaw` 回调。

## 职责

- 将嵌套对象、数组和标量递归展开为带稳定 path、scope、preview 和 search text 的条目。
- 对 path 与 value 做大小写无关的包含过滤。
- 为首个命中生成有前后文边界的摘要，并把所有命中拆为普通/高亮文本段。
- 对正则特殊字符做安全转义。
- 计算命中索引的 clamp 和首尾循环导航。

## 非职责

- 不决定 System、Tools、Messages、Response 等区块的数据来源；该职责属于 `raw-view-model.js` 和调用方。
- 不读取翻译缓存，也不决定原文/翻译模式。
- 不查找可见 DOM 节点，不滚动页面，不维护输入法组合状态。

## 验证

```bash
npm run smoke:raw-search-model-contract
npm run smoke:raw-search-controller-contract
```

契约覆盖嵌套路径、scope、path/value 命中、大小写与特殊字符、高亮分段以及循环导航。真实浏览器 smoke 继续负责可见计数、按钮跳转和滚动位置。

浏览器资源注册由 `src/server/viewer-static-assets.mjs` 管理；`smoke:viewer-static-assets-contract` 会解析 `client.js` 的相对 import，确保每个拆出的浏览器模块都有白名单路由和真实文件。
