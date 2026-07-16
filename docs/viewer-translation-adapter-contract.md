# Viewer Translation Adapter 契约

更新时间：2026-07-14

`src/server/viewer-translation-adapter.mjs` 是 Viewer Trace 与通用翻译服务之间的适配边界。它回答“从哪条 Trace 读取哪些材料”，但不拥有 HTTP、Source 存储、翻译 provider 或浏览器展示。

## 所有权

Adapter 负责：

- 将整条 Source、单个 Request 或浏览器提交的显式材料转成 `TranslationMaterialCollector` 输入；
- 通过 `src/translation/request-materials.mjs` 的共享投影读取 framework reminder、`/compact`、slash command 展开和 Suggestion Mode；
- 保留 request/source occurrence，使缓存块仍可追溯到原始 Trace；
- 把生成与缓存读取委托给 `TranslationService`。

Adapter 不负责：

- 解析 URL、HTTP method、intent 或 response；
- 决定 live/SQLite/file/imported Trace 的读取方式；
- 生成翻译 hash、写缓存文件、调用 provider 或执行翻译脚本；
- 拼接 Viewer HTML 或管理浏览器翻译状态。

## 注入端口

```text
loadViewerData({ sourceId, requireSource })
  -> { source, requests }

loadRequestDetail({ sourceId, requestId, requireSource })
  -> { source, request }
```

这两个端口必须同步返回 Viewer Trace DTO。单 Request 刷新必须只走 `loadRequestDetail`，不得退化为整条 Source 加载。Source 类型和存储后端由 `SourceRepository`、`SourceCaptureReader` 与 Viewer composition root 决定。

`sanitize`、`slugify` 和 `tooLarge` 同样由 composition root 注入，以继续复用 Viewer 的公开输入、安全路径和 HTTP 413 策略。

## Harness 材料

`extractHarnessTranslationParts()` 由 `src/translation/request-materials.mjs` 所有并复用 `src/trace/message-semantics.mjs`；Adapter 保留兼容导出。当前只产生：

- `harness_reminder`
- `harness_compact`
- `harness_command`
- `harness_suggestion`

后台 task notification 和子 Agent 结果不是待翻译的 Harness 提示词，必须排除。新增 Harness 语义时，先扩展共享 message semantics 与 request-material projector，再更新 Adapter 契约；不要在 HTTP route 或浏览器里新增第二套 marker 判断。

## 验证

```bash
npm run smoke:viewer-translation-adapter-contract
npm run smoke:translation-materials-contract
npm run smoke:translation-service-contract
npm run smoke:harness-translation
```

直接 Adapter smoke 锁定 Source/Request 读取选择、Harness 分类、occurrence 和 service 委托。Harness HTTP smoke 继续证明真实 Viewer 路由、局部读取、翻译 worker 与公开缓存能闭环运行。
