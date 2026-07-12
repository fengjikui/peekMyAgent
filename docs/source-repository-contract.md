# Viewer Source Repository 契约

更新时间：2026-07-12

Viewer 的 source 可能来自实时 watch、SQLite、文件/demo 或导入 Trace。`src/server/source-repository.mjs` 提供它们共同的最小 repository 门面，避免路由、Viewer load、request detail 和 Trace export 分别拼装不同的 source 列表。

## 最小 SourceSummary

所有 provider 输出在越过 repository 边界前必须至少满足：

- `id`：稳定、非空的 source 标识；
- `label`：当前用于展示的标题；
- `kind`：来源类别；
- `available`：底层证据当前是否可读；
- `request_count`：可选的非负统计值。

现有 API 暂不增加 DTO `schema_version`，避免改变公开 JSON；运行时契约本身由 `SOURCE_SUMMARY_CONTRACT_VERSION=1` 标识。将来若公开 API 版本化，应在 API envelope 层统一增加，而不是只给某一类 source 加字段。

## Provider 顺序

repository 按以下固定顺序收集：

1. base：实时 watch、用户指定 evidence、显式 demo；
2. persisted：SQLite 中且当前没有 live watch 覆盖的会话；
3. imported：portable Trace 导入目录。

随后统一应用 title、pin、archive/hidden 和 project 装饰。排序和隐藏必须发生在 source resolve 之前，因此空选择的 fallback 与左侧栏第一项一致。

## 当前边界

repository 门面负责 provider 汇聚、运行时校验和 source 解析。custom evidence 与显式 demo 位于 `file-source-provider.mjs`；imported Trace 目录/manifest 位于 `imported-trace-source-provider.mjs`；SQLite source 的 live 去重、标题优先级和最小 capture 推断位于 `persisted-source-provider.mjs`；通用控制字符/空白/fallback/截断规则位于 `source-text.mjs`。Trace 语义标题清洗与首条用户请求推断仍由 Viewer 作为 title policy 注入，避免 provider 反向依赖消息解释。

live capture 统计仍由 `viewer/server.mjs` 负责，source lifecycle 也尚未迁出。这是明确的过渡边界，不应描述为 source 领域已经完全拆分。

后续迁移顺序：

1. live provider（需要先分离 watch runtime 与 Trace summary）；
2. source lifecycle service（rename/archive/delete/project 操作）。
