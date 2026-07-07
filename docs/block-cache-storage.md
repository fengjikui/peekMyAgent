# 分块缓存存储设计

更新时间：2026-07-07

本文记录 peekMyAgent 的 capture 存储去重策略。目标是让长会话在逻辑上仍可完整复盘，但本地 SQLite 不再为每一轮请求重复保存相同的 system prompt、tools、skill/harness 提示和历史消息。

## 背景

Claude Code / OpenClaw 这类 Agent 每次请求模型时，通常会重新携带大量上下文：

- system prompt 和 harness 注入说明；
- tools schema / description / 参数描述；
- skill 描述；
- 历史 messages；
- 前几轮 assistant 回复和 tool result。

这些内容在逻辑 raw body 中必须存在，否则模型无法正确接续上下文。但如果每条 capture 都把完整 JSON body 存一份，几轮对话就可能让本地 store 膨胀到数十 MB 甚至上百 MB。

## 设计目标

- **无损重建**：Raw 面板、导出、详情 API 仍能看到完整请求体。
- **写入即去重**：新 capture 默认不再保存完整 `raw_body_json`，而是保存 ordered request tree 和 content blobs。
- **稳定分块**：重复度高的内容按自然边界拆块，提高 hash 命中率。
- **旧数据可压缩**：已有 store 中保留的 `raw_body_json` 可以通过 `pma compact` 清理。
- **翻译缓存不冲突**：翻译继续按可翻译文本块缓存；存储块负责精确还原，两者语义不同，不强行复用同一个 hash。

## 当前分块粒度

请求体会被保存为两部分：

- `request_tree_nodes`：记录 JSON 的对象/数组顺序、key、index 和 blob 引用位置。
- `content_blobs`：按内容 hash 存放可复用大块。

当前可复用块包括：

| JSON 位置 | kind | 粒度 |
| --- | --- | --- |
| `$.system` 字符串 | `system_block` | 整个 system 字符串 |
| `$.system[i]` | `system_block` | 每个 system 数组项 |
| `$.tools[i]` | `tool_schema` | 每个工具 schema / description |
| `$.messages[i]` | `message` / `tool_result` | 每条历史消息 |

其中 assistant 下行回复进入后续请求历史时，也作为一条 `message` 块保存。这样后续请求只需要引用同一个历史消息块，不需要重复保存完整 assistant 回复。

## 为什么 tools 不再整组缓存

早期实现中曾把整个 `$.tools` 数组当成一个块。这样虽然简单，但只要工具数量、顺序或单个工具发生微小变化，整组工具都会失去命中。

现在改为 `$.tools[i]` 一个工具一个块。常见的工具 schema 长期稳定，跨请求、跨会话都可以命中同一个全局内容块。

## 新旧数据行为

新 capture 写入时：

1. 解析请求 body。
2. 构建 ordered request tree。
3. 将 system/tool/message 等块写入 `content_blobs`。
4. `model_requests.raw_body_json` 默认写 `NULL`。
5. Raw 读取时从 tree + blobs 重建完整 body，并标记 `body_source = "reconstructed"`。

旧 capture：

- 如果 `raw_body_json` 仍存在，旧读取路径仍可用。
- 如果 tree/blobs 完整，可以执行 `pma compact` 清掉 `raw_body_json`。

## 维护命令

```bash
pma compact
```

作用：

- 停止当前 dashboard daemon，避免压缩时有并发写入。
- 清理可以从 request tree 重建的 `raw_body_json`。
- 默认执行 SQLite `VACUUM`，回收文件空间。

可选：

```bash
pma compact --watch <watch-id>
pma compact --limit 1000
pma compact --no-vacuum
pma compact --json
```

该命令不会删除会话，也不会清理 content blobs。它只移除重复的完整 raw body 副本。

## 与翻译缓存的关系

存储块和翻译缓存都叫“块”，但语义不同：

- 存储块必须精确、无损、可重建，hash 基于原始 JSON 片段。
- 翻译块面向可读文本，会做轻量归一化，例如模型名、工作目录、日期、memory 路径等易变文本。

因此二者不应强行共用同一个 hash。否则可能出现两类风险：

- 为了翻译命中做归一化，破坏 Raw 还原准确性。
- 为了 Raw 精确还原，不必要地降低翻译缓存命中。

当前策略是：

- 存储层按 JSON 自然边界保存 exact blocks。
- 翻译层继续按 `kind + normalized source_text` 缓存。
- 两者共享抽取边界：system、tools、harness、messages 的展示与翻译都从同一份重建 body 读取。

## 测试约束

相关 smoke：

```bash
npm run smoke:request-tree
npm run smoke:persistence-store
npm run smoke:trace-bundle
```

`smoke:request-tree` 约束：

- system 数组项可以独立命中；
- tool schema 按单工具命中；
- message / tool_result 按单条消息命中；
- 重建结果与原始请求深度相等。

`smoke:persistence-store` 约束：

- 新 capture 不再写入 `raw_body_json`；
- Raw 可从 request tree + content blobs 重建；
- 相同 tool schema 只存一次但被多次引用；
- 旧 `raw_body_json` 可通过 compaction 清理，清理后仍能重建。

`smoke:trace-bundle` 约束：

- 导出仍得到完整 capture 内容；
- 导入后仍可只读查看；
- 导出脱敏和路径安全不受存储策略影响。

## 文档同步约定

修改以下内容时，需要同步检查本文：

- `src/core/request-tree.mjs` 的分块规则；
- `src/core/persistence-store.mjs` 的 schema、写入、读取、compaction；
- `src/viewer/server.mjs` 的导出/导入和翻译材料抽取；
- CLI 中 `pma compact` 的行为或参数；
- 与 Raw、翻译缓存、Trace 分享相关的用户可见语义。

避免文档漂移的做法：

- 先把关键行为写进 smoke；
- 文档只描述 smoke 覆盖的当前行为，不描述尚未实现的推测方案；
- 新增缓存类型时，同时更新分块表格和测试断言。
