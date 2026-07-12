# Translation Service 契约

更新时间：2026-07-12

`src/translation/service.mjs` 负责翻译材料落盘、缓存发现和翻译脚本编排。Viewer HTTP 路由只读取输入并提供当前 source/request 的材料适配器；缓存路径和脚本产物路径不会暴露给浏览器。

## 生成流程

1. 统一清洗 agent、target language、source、section 和 request ID；
2. 用户提交块时直接使用共享 Collector，source/request 刷新时通过 Viewer material provider 获取材料；
3. 没有指定 source 时运行离线 `extract-translation-materials.mjs`；
4. materials 与 manifest 以私有权限写入 agent/language 目录；
5. 调用 `translate-materials-zh.mjs`，并把并发限制在 1 到 100；
6. `force` 只重译本次材料 hash；
7. 重新读取缓存并返回不含本机路径的公开状态。

## 缓存发现

缓存首先按当前 agent slug 查找，再按兼容 alias 回退：

- Claude/Anthropic/CC -> `claude-code`；
- Trae -> `trae-cn`。

缓存响应包含 `available`、target language、provider、manifest 摘要、entry count 和可选 entries，不包含 `cache_path`。生成响应不返回完整 entries，避免一次刷新把大缓存重复传给前端。

## 边界

- `TranslationMaterialCollector` 负责块语义、hash、去重与材料限额；
- `TranslationService` 负责文件、缓存和进程副作用；
- Viewer policy 负责 Claude Code harness 语义与 API 输入错误映射；
- LLM provider、并发 job、长块拆分和格式校验仍由 `translate-materials-zh.mjs` 负责。

任何新翻译入口必须复用这两层，不得自行拼 cache path、hash 或 force 列表。
