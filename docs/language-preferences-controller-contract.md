# Viewer 语言偏好契约

更新时间：2026-07-14

本文描述 Viewer 的界面语言、翻译目标语言和原文/译文模式当前由谁负责。它记录已实现行为，不是未来设想。

## 模块边界

`src/viewer/translation-language-catalog.js` 是纯语言目录与解析层：

- 保存当前支持的两种 UI 语言和完整翻译目标语言目录；
- 将语言代码、展示名、`展示名 · code` 和已声明 alias 解析为稳定代码；
- 根据浏览器语言列表推荐默认翻译目标，区分简体与繁体中文；
- 为无效持久化值提供确定性回退。

该模块不访问 DOM、Store、`localStorage`、网络或翻译缓存。

`src/viewer/language-preferences-controller.js` 是浏览器偏好生命周期：

- 从 `localStorage` 水合 UI 语言、目标翻译语言和原文/译文模式；
- 渲染并长期绑定两个语言选择器；
- 更新静态 `data-i18n*` 节点和 `document.documentElement.lang`；
- 通过 `ViewerClientStore.setLanguage()` 原子提交语言状态；
- 在目标语言变更前后调用注入端口，使翻译 operation 失效、清理自动刷新尝试、重载当前 Source 缓存并刷新可见界面；
- 集中持久化三个语言偏好 key，避免 `client.js` 和 feature controller 各写一份。

该控制器不拥有翻译 cache/lookup、provider 生成、翻译块 HTML、Raw 搜索或 Source 数据。上述能力继续分别属于 `TranslationCacheController`、`TranslationActionController`、translation Model/Renderer、`RawSearchController` 和 Source lifecycle。

## 切换顺序

目标翻译语言从 A 切换到 B 时：

1. 规范化 B；若与当前稳定代码相同，只修正选择器，不触发网络副作用。
2. 调用 `onTargetLanguageChanging`，使旧生成 operation 和旧自动刷新上下文失效。
3. Store 一次提交 `targetTranslationLanguage=B`、`translationMode=B`。
4. 持久化目标语言和当前模式。
5. 调用 `onTargetLanguageChanged`，装配层重载当前 Source 的 B 语言缓存。
6. 重绘选择器；具体 Timeline/Raw 刷新仍由装配回调决定。

UI 语言切换不触发翻译 provider，只更新 Store、持久化偏好、静态文案和注入的可见 feature 标签。

## 修改规则

- 新增 UI 文案仍必须同时更新 `ui-i18n.js` 的中英文 key 和 i18n smoke。
- 新增翻译目标语言只改 catalog，并补 alias/系统语言解析契约；不要把语言数组搬回 `client.js`。
- 新的翻译缓存或 provider 行为不得加入本控制器。
- 所有异步切换副作用必须经注入端口；控制器不得直接引用全局 feature controller。
- 浏览器选择器或持久化行为变化必须同步本文、`architecture.md`、`codebase-map.md` 和确定性 smoke。

## 验证

```bash
npm run smoke:language-preferences-controller-contract
```

该契约覆盖语言 alias、系统语言推荐、无效值回退、偏好水合、静态 i18n、选择器渲染、切换顺序、持久化、模式切换和事件幂等绑定。
