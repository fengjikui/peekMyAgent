# Translation Material 契约

更新时间：2026-07-12

`src/translation/materials.mjs` 定义 Viewer 局部刷新、整段刷新和离线提取脚本共享的翻译材料模型。它不调用 LLM，也不读取或写入缓存，只负责从标准化请求/capture 中形成稳定的块。

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

Claude Code 的 compact/command/suggestion/reminder 判断通过 `extractHarnessParts` policy 注入。Collector 不依赖 Viewer、HTTP、SQLite 或具体 LLM provider。

## 回归约束

- Viewer 与 `scripts/extract-translation-materials.mjs` 必须复用同一个 Collector。
- section 刷新只产生当前 system、tools 或 harness 类型的材料。
- 同一归一化块的 hash、metadata 和 occurrence 顺序必须稳定。
- 新增可翻译材料类型时，必须同步检查 UI 国际化文本、复制行为、缓存命中和主动重译路径。
