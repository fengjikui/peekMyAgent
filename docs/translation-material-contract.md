# Translation Material 契约

更新时间：2026-07-15

`src/translation/request-materials.mjs` 定义 Node 与浏览器共享的请求材料投影；`src/translation/materials.mjs` 在其上增加 hash、occurrence、metadata 清洗和大小限制。两者都不调用 LLM，也不读写翻译缓存。

共享投影拥有 System parts、Tools schema descriptions 和 Harness 注入的提取语义。Viewer 可为 Harness 材料注入本地化标签，但不得重写 compact、command、suggestion 或 system-reminder 的识别规则。

## 块级粒度

- 每个 system prompt part 是一个块；
- 每个工具 description 是一个块；
- input schema 中每个字段 description 是一个块；
- 每个 harness reminder、compact、command 或 suggestion 注入是一个块；
- 用户主动请求的 thinking/manual text 是一个块。

块 hash 继续使用 `kind + normalizeTranslationSourceText(source_text)`。日期、模型名、工作目录和项目 memory 路径等已知易变系统行先归一化，命中相同 hash；不会做可能改变真实语义的泛化归一化。

## 去重与 occurrence

同一 hash 只保存一份 source text，所有命中的 source/request/index/workspace/conversation 追加到 `occurrences`。历史请求和跨会话重复的 system/tool 块因此能够复用同一翻译缓存；历史 message 本身不作为跨会话翻译材料。

## 安全与边界

- 最多 1500 个材料；
- 单块最多 200000 字符；
- 总计最多 2000000 字符；
- metadata 限 32 个 key、两层嵌套和每个字符串 512 字符；
- billing header 等不可翻译控制信息被跳过；
- metadata 去控制字符、压缩空白并截断。

Claude Code 的 compact/command/suggestion/reminder 判断由共享 `extractHarnessTranslationParts()` 复用 `src/trace/message-semantics.mjs`。Collector 通过 `extractHarnessParts` 端口接入该 policy，因此仍不依赖 Viewer、HTTP、SQLite 或具体 LLM provider。

## 回归约束

- Viewer、Viewer Adapter 与 `scripts/extract-translation-materials.mjs` 必须复用同一个 request-material projector 和 translation block contract；浏览器不得复制服务端提取规则。
- section 刷新只产生当前 system、tools 或 harness 类型的材料。
- 同一归一化块的 hash、metadata 和 occurrence 顺序必须稳定。
- 新增可翻译材料类型时，必须同步检查 UI 国际化文本、复制行为、缓存命中和主动重译路径。

聚焦验证：

```bash
npm run smoke:translation-materials-contract
npm run smoke:viewer-translation-adapter-contract
npm run smoke:viewer-static-assets-contract
npm run smoke:raw-search-browser
```
