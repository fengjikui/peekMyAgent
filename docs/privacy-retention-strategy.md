# 隐私、留存与合规边界策略

## 1. 默认隐私原则

peekMyAgent 应遵循这些默认原则：

- **最小采集**：只记录回放、调试和检查所需的数据。
- **默认本地**：默认不上传日志，不发送给第三方分析服务。
- **默认保护敏感信息**：尽量识别并脱敏密钥、token、凭证、私钥、个人信息、商业机密和敏感 prompt。
- **默认短期留存**：除非用户明确开启长期保存，否则自动清理。
- **默认透明**：说明记录什么、存在哪里、保留多久、仍有什么风险。
- **默认可撤回**：用户可停止记录、清空历史、导出或删除本地数据。
- **默认不训练**：捕获内容不用于模型训练、分析或产品改进，除非用户明确同意。

## 2. 脱敏与过滤

日志写入前必须经过统一敏感信息过滤层。查看器也要再做一次展示层脱敏，避免旧日志或异常数据绕过保护。

默认脱敏目标：

- API key、access token、refresh token、bearer token。
- SSH key、GPG key、证书、webhook secret。
- `.env` 文件和带有 secret 字段名的配置值。
- cookie、session ID、authorization header。
- 数据库连接串和云服务凭证。
- 邮箱、手机号、证件号、银行卡号等常见个人信息模式。
- 标记为 confidential、secret、private、internal 的内容。
- 用户配置的路径、字段或正则匹配内容。
- 工具输出或模型响应里的敏感片段。

过滤方式：

- 用正则匹配常见 token 模式。
- 对 `authorization`、`cookie`、`password`、`token`、`secret`、`api_key` 等字段做结构化过滤。
- 默认阻断 `.env`、证书、私钥、生产凭证文件的完整记录。
- 对文件片段、工具输出和上下文块做长度截断。
- 支持用户配置 ignore paths、字段名和正则。
- 查看层再次脱敏，形成双层保护。

脱敏标记示例：

```text
OPENAI_API_KEY=[REDACTED:api_key]
Authorization: Bearer [REDACTED:token]
/Users/example/project/.env [REDACTED:file_blocked]
```

## 3. 本地优先存储

默认存储边界：

- 原始交互内容只保存在本地。
- 脱敏索引和摘要只用于本地搜索。
- 崩溃报告不包含 prompt、文件内容、工具输出或用户消息。
- 如果未来增加产品分析，只能记录非内容指标，例如功能开关、耗时和错误类型。

存储要求：

- 日志目录清晰可见，用户能打开或清空。
- 导出默认使用脱敏内容；当前实现会递归脱敏常见 token/API key pattern，并保留导出前自审提示。
- 未脱敏导出需要明确确认。
- 未来可选本地加密，密钥由系统钥匙串或用户本地凭据管理。
- 云同步、远程备份或遥测都必须单独显式开启。

去重缓存要求：

- system 可解释块、tools、单条 message 和大块 raw body 可以用 hash 去重，但缓存索引不能只有 hash。
- 缓存记录应包含 `created_at`、`first_seen_at`、`last_seen_at`、`ref_count` 或可重建引用索引。
- 清理某个会话、某个时间点之前的轮次或某个项目时，必须能删除不再被引用的 blob。
- 页面折叠不删除数据；硬盘级清理必须走 dry-run 和确认流程。
- 不应默认提供“按时间点直接删除所有旧消息正文”的硬盘清理，因为后续模型请求的 history 可能仍然引用早期 message blob。
- 第一版优先支持清空整个会话、清空会话 raw body、清空项目/Agent 的旧会话、删除无引用 blob。
- 若未来支持“清理当前轮次之前”，必须先做引用分析并展示将保留哪些被后续请求引用的块。

## 4. 留存与清理

peekMyAgent 不能制造无限增长的日志目录。

### 4.1 默认策略

MVP 默认策略建议：

- **默认保留最近 7 天**。
- **默认全局上限 1GB**，超过后从最旧会话开始清理。
- **单个会话默认上限 50MB**，超过后保留索引和摘要，折叠或丢弃最旧 raw body。
- **单次请求 raw body 默认上限 2MB**，超过后截断并标记 `truncated=true`。
- **stream chunk 原始事件默认最多保留 24 小时**，同时保存重组后的 assistant message、tool calls、usage 和错误信息。
- **导出包默认保留 7 天**，用户主动标记“保留”的导出不自动删除。
- **临时文件默认 24 小时清理**。
- **SQLite 索引不计入原始日志，但必须支持重建**；删除日志时同步删除对应索引。
- 删除会话时，同时删除 raw body、response chunks、附件、索引、缓存和派生摘要。

这些默认值的目标不是长期归档，而是让用户完成本地观察、调试和导出。长期保存必须显式开启。

### 4.2 存储分层

日志不能只按“一个大 JSON 文件”保存，应分层治理：

| 类型 | 示例 | 默认保留 | 清理方式 |
| --- | --- | --- | --- |
| metadata | agent、project、session、timestamp、hash、token/长度统计 | 30 天 | 超期删除或压缩 |
| normalized request | 脱敏后的 messages、tools shape、role 序列 | 7 天 | 按时间和全局上限清理 |
| raw request body | 完整 system、tools、user、tool result | 7 天，单请求 2MB | 超限截断，超期删除 |
| response metadata | status、latency、usage、finish_reason、chunk_count | 30 天 | 超期删除或压缩 |
| raw response / stream chunks | SSE chunk、完整模型回复 | 24 小时默认 | 只保留重组结果，删除原始 chunks |
| tool artifacts | 文件片段、截图、命令输出、附件 | 7 天，单项限额 | 按会话和大小清理 |
| exports | HTML、Markdown、JSONL、贡献包 | 7 天 | 用户标记保留后跳过 |
| temp/cache | 中间文件、端口状态、预览缓存 | 24 小时 | 启动和退出时清理 |

### 4.3 用户可配置项

- 关闭日志。
- 仅记录元数据。
- 记录 request，不记录 response raw body。
- 记录 response metadata，不记录 stream chunks。
- 保留 1 天、7 天、30 天、90 天或永久。
- 设置最大磁盘占用，例如 200MB、1GB、5GB、自定义。
- 设置单会话最大体积。
- 设置单请求 raw body 最大体积。
- 清空全部日志。
- 按项目、Agent 或会话清空。
- 按时间范围清空。
- 自动清理导出包。
- 导出前始终脱敏。

永久保存、关闭脱敏、保存完整响应流、保存完整工具输出都必须显示风险提示。

### 4.4 清理行为

- 应在应用启动时执行，也支持 `peekmyagent cleanup`。
- 支持 `--dry-run`。
- 支持 `--keep-days`、`--max-size`、`--scope agent|workspace|conversation|exports|temp`。
- 支持 `--include-raw-response` 和 `--include-exports` 这类明确范围开关。
- 清理前应生成清理计划：会删除多少会话、多少 raw body、多少 stream chunk、释放多少空间。
- 清理错误只记录非敏感信息。
- 永久保存选项必须给出风险提示。
- 未来团队模式支持管理员统一策略。

CLI 示例：

```bash
peekmyagent cleanup --dry-run
peekmyagent cleanup --keep-days 7 --max-size 1GB
peekmyagent cleanup --scope conversation --id <conversation_id>
peekmyagent cleanup --scope temp
peekmyagent cleanup --scope exports --keep-days 7
```

### 4.5 前端设置入口

前端工作台必须提供一个明显的“设置”入口，建议放在右上角齿轮按钮。

设置页包含：

- 当前数据目录。
- 当前磁盘占用。
- 预计可清理空间。
- 全局留存天数。
- 全局最大占用。
- 单会话最大占用。
- 单请求 raw body 上限。
- 是否保存完整 request raw body。
- 是否保存完整 response raw body。
- 是否保存 stream chunks。
- 是否保存工具输出附件。
- 导出包保留天数。
- 一键清理临时文件。
- 一键清空当前会话。
- 一键清空全部历史。
- 打开日志目录。

设置页不应只展示开关，还应展示每个选项的风险提示，例如“保存完整 raw body 可能包含 system prompt、API key、源码片段和个人信息”。

## 5. 用户授权与风险提示

首次启用捕获时，应说明：

- 工具可能记录系统提示、用户消息、工具调用、模型响应、文件片段和错误。
- 日志可能包含密钥、个人信息、商业信息或内部 prompt。
- 默认开启脱敏，但无法保证识别所有敏感值。
- 日志默认保存在本地。
- 用户可关闭捕获、清空历史、调整留存。

建议提示文案：

```text
peekMyAgent 会记录 Agent、模型和工具之间的交互，用于本地回放和调试。
这些日志可能包含密钥、个人信息、商业数据或 prompt 内容。
peekMyAgent 默认本地保存并启用脱敏，但没有任何过滤器是完美的。
导出、上传或分享日志前，请先检查内容。
```

高风险操作需要二次确认：

- 开启云同步或远程上传。
- 导出未脱敏日志。
- 永久保存日志。
- 记录完整文件内容。
- 关闭脱敏。
- 分享会话。
- 上传日志用于支持排查。

## 6. 测试清单

脱敏测试：

- API key 会被替换。
- bearer token 会被替换。
- cookie 和 session ID 会被替换。
- `.env` 内容默认不会完整记录。
- SSH key、证书、webhook secret 会被阻断或脱敏。
- 数据库连接串会被脱敏。
- 常见个人信息模式可被检测。
- 工具输出会经过过滤。
- 模型响应内容会经过过滤。
- 查看器会执行第二层脱敏。

存储测试：

- 默认日志只在本地。
- 关闭日志后不再写入消息正文。
- metadata-only 模式不保存 prompt 文本。
- 用户能打开并清空日志目录。
- 导出默认脱敏。
- 崩溃报告不包含 prompt、用户消息、文件内容和工具输出。

留存测试：

- 超过默认留存窗口的日志会被清理。
- 超过最大磁盘占用时会清理旧数据。
- 删除会话会移除附件、索引和缓存。
- 清理失败不会导致应用崩溃。
- 手动清空后，应用内不可再见本地数据。
- 临时文件和导出文件有独立清理路径。

授权测试：

- 首次捕获设置会展示风险提示。
- 云同步需要显式同意。
- 未脱敏导出需要确认。
- 关闭脱敏需要确认。
- 永久留存会展示风险提示。
- 用户能随时关闭捕获。

合规边界测试：

- 日志默认不用于训练。
- 日志默认不上传第三方服务。
- 用户撤回同意后停止相应处理。
- 删除覆盖原始日志、索引、缓存和摘要。
- 团队模式可执行统一留存和导出策略。
