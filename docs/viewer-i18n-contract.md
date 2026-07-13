# Viewer UI 国际化契约

更新时间：2026-07-14

本文描述 Viewer 界面语言资源的当前实现边界。目标翻译语言用于翻译 system prompt、工具说明等 Trace 内容，属于另一套产品设置，不在本契约内。

## 模块边界

- `src/viewer/ui-i18n.js` 唯一持有 `zh-CN`、`en-US` UI 资源、默认语言和 `translateUi()`。
- `src/viewer/client.js` 只根据 Store 中的 `uiLanguage` 调用 `translateUi()`，不再维护第二份词典。
- feature model、renderer 和 controller 通过注入的 `translate(key, vars)` 获取文案，不直接导入全局状态，也不自行建立局部词典。
- `src/viewer/index.html` 的初始可访问文本使用 `data-i18n`、`data-i18n-title` 或 `data-i18n-aria-label` 引用同一资源。

## 资源规则

1. 两种 UI 语言必须提供完全相同的 key。
2. 同一个 key 在两种语言中必须保留相同的 `{placeholder}` 集合。
3. value 必须是非空字符串；未知语言回退到 `zh-CN`，未知 key 原样返回 key。
4. 新增或修改用户可见文案、tooltip、ARIA label 时，必须同步检查两种语言。
5. UI 目前只支持中英文；增加一种 UI 语言是产品范围变更，不应因为目标翻译语言列表较长而自动扩展。

## 验证

```bash
npm run smoke:viewer-i18n-contract
```

门禁会检查资源完整性、占位符一致性、fallback/插值行为，以及 Viewer JavaScript 和 HTML 中所有静态 i18n key 是否真实存在。它也检查 `client.js` 只做装配，防止资源重新回流到超大应用文件。

修改语言切换、持久化或页面初始文案后，还应在真实浏览器中执行 `中文 -> English -> 中文`，检查 Header、左栏、动作菜单、tooltip/ARIA 和控制台错误。
