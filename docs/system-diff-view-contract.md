# System Diff View 契约

更新时间：2026-07-14

System diff 是 Raw Inspector 中按需打开的诊断视图。它比较相邻请求中抽取出的 System 文本，但不能因为输入很大而在浏览器主线程建立无界的二维矩阵。

## 模块边界

- `src/viewer/system-diff-model.js` 是纯模型。它接收前后两段文本，决定使用精确行级 diff、完全一致结果或有界块摘要，并返回可渲染 DTO。
- `src/viewer/system-diff-renderer.js` 只把显式 DTO、请求编号和注入的 i18n/转义函数转换为 HTML。
- `src/viewer/client.js` 只负责从相邻 request 提取 System 文本、调用模型并装配 Renderer。
- 模型和 Renderer 不读取全局 `state`、DOM、网络、翻译缓存或 request 对象。

## 精确模式

只有同时满足以下默认上限时才运行行级 LCS：

- 前后文本合计不超过 256 KiB 字符；
- 单行不超过 20,000 字符；
- 前后合计不超过 1,000 行；
- `(beforeLines + 1) * (afterLines + 1)` 不超过 250,000 个矩阵单元。

矩阵使用 `Uint32Array`，避免普通 JavaScript 数字数组的额外对象成本。输出只保留变化行附近默认 4 行上下文，其余相同内容折叠为 skip row。

## 有界摘要模式

任一精确上限被触发后，模型不会继续扩大 LCS 矩阵，而是：

1. 线性确认完全相同的行前缀和后缀；
2. 只对中间变化区分块；
3. 根据变化区大小动态调整块尺寸，确保每侧不超过 256 个块；
4. 为完整文本和每个块计算稳定的非加密内容指纹；
5. 在块指纹上运行有界 LCS，并只保留变化块附近 1 个匹配块。

摘要明确展示前后行数、共同前后缀、块尺寸和完整文本指纹。内容指纹只用于快速相等判断和诊断展示，不是安全哈希，也不能替代 Raw System 证据。

## 语义边界

- 换行符会统一为 `\n`，所以 CRLF 与 LF 不产生可见 diff。
- 完全相同的抽取文本显示“一致”，不伪装成结构级结论。
- System 原始对象结构、非文本字段或抽取规则变化仍应在 System 原文视图检查。
- 有界摘要中的块增删数量不是精确行增删数量；界面必须称为“内容块”。
- 所有文本和预览在 Renderer 中转义，不允许 System 内容注入 HTML。

## 验证

```bash
npm run smoke:system-diff-view-contract
npm run smoke:viewer-i18n-contract
npm run smoke:viewer-static-assets-contract
```

契约 smoke 覆盖小输入行级结果、换行归一化、上下文折叠、5,000 行退化路径、输出上限、双语 Renderer 和恶意 HTML 转义。
