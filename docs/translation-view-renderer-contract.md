# Viewer 翻译视图契约

更新时间：2026-07-13

本文记录 Raw Inspector 中 System、Tools 和 Harness 翻译视图的当前模块边界。翻译块的身份、规范化和 hash 契约仍以 [翻译块协议](translation-block-contract.md) 为准；这里不重新定义缓存 key。

## 模块职责

### `translation-view-model.js`

这是无 DOM、无网络、无全局状态的纯数据层，负责：

- 按工具名聚合工具说明和参数说明。
- 在原文、当前译文、工具名、参数名和材料标签中筛选查询词。
- 工具搜索结果按“工具名完全匹配、工具名部分匹配、内容匹配”稳定排序。
- 计算当前材料的缓存命中、缺失数量。
- 生成 Renderer 使用的显式 DTO，包括 display text、原文、命中状态、类型样式、参数组材料和搜索目标。

它通过调用方注入的 `translatedTextFor(kind, sourceText)` 读取译文，因此不依赖缓存 Map，也不重复实现 `translationLookupKey`。

### `translation-renderer.js`

这是只消费显式 DTO 和渲染依赖的 HTML Renderer，负责：

- 原文/目标语言切换、缓存状态、复制全部和刷新区块工具栏。
- System/Harness 块、工具组、工具说明和紧凑参数汇总的结构化 HTML。
- HTML 转义、Markdown 预览和原文折叠区。
- 向调用方请求 action id，并把 id 写入复制/重译按钮。

Renderer 不读取 `state`、不访问 DOM、不请求翻译 provider，也不直接修改动作表。它只通过 `registerAction(descriptor)` 注入点声明当前按钮需要的动作材料。

### `client.js`

应用装配层当前仍负责：

- 从已水合 request 收集 System、Tools 和 Harness 翻译材料。
- 用共享 `translationLookupKey` 查询当前语言缓存。
- 维护翻译模式、生成状态、动作表和活动 request/section。
- 把动作描述符补全为 request、section、surface 后注册。
- 处理复制、整段刷新和块级重译的浏览器事件。

材料提取后续应随共享 request protocol 继续收敛；动作表会在最小 Client Store 阶段迁出，但本次拆分不改变二者行为。

## 行为不变量

1. Search 只过滤当前可见的结构化翻译内容；原文模式继续搜索原始 JSON。
2. 工具名、参数名、原文和译文都可命中搜索；工具名完全匹配排在最前。
3. 工具参数仍作为一个视觉容器和一个重译动作提交，动作中保留每个参数的 `kind`、`source_text` 与 metadata。
4. 译文缺失时显示原文；命中时显示译文，原文始终可以展开查看。
5. 复制和重译按钮只持有临时 action id，不把大段提示词写入 HTML data attribute。
6. 所有材料仍通过共享 translation block identity 查询缓存，已有缓存无需迁移。
7. 所有用户可见文案继续通过现有中英文资源表取得；本次重构不新增界面文案。

## 验证

确定性契约：

```bash
npm run smoke:translation-view-renderer-contract
npm run smoke:viewer-static-assets-contract
```

真实浏览器回归应至少覆盖：

- System 原文/译文切换、缓存状态和搜索跳转。
- Tools 工具名搜索、工具说明、参数汇总和原文展开。
- Harness 结构化翻译列表。
- 复制与重译按钮可点击，且浏览器控制台无模块加载或运行错误。
