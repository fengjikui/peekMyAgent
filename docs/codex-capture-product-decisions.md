# Codex 捕获首版产品决策

状态：首版已实现。本文记录当前范围、证据边界和后续仍需逐点讨论的产品取舍；已实现行为同步记录在 `docs/architecture.md`。

## 产品目标

让使用 Codex Desktop 或 Codex CLI 的用户，在不改变日常工作习惯的前提下，看清一次任务中的用户输入、上下文组装、模型回复、工具调用与结果、子任务以及上下文压缩。需要完整系统提示词和工具 schema 的用户，可显式启用深度捕获。

## 两种捕获模式

### 本地观察

- 默认启用，只读 `$CODEX_HOME` 中的 thread catalog 与用户显式选择的一个 rollout JSONL。
- 首次使用由用户选择一条会话，之后只保留 thread id 作为观察引用；不把 Codex 历史正文复制进 peekMyAgent SQLite。
- 切换观察对象只是更换只读引用，不修改 Codex 配置，不接触认证信息，不转发网络流量。
- 展示用户/Assistant 消息、reasoning 摘要、工具调用与结果、Turn、子 thread 和压缩事件。
- provenance 使用 `codex_rollout_local`。它是 Codex 自己保存的语义事件，不等同于网络层完整请求。

### 精确代理

- 由用户显式启动受管 Codex 会话，用于查看真正发送到模型服务的 Responses 请求与回复。
- 会话级注入临时 HTTP-only Responses provider，退出后不留下持久配置修改；禁用 WebSocket 是为了让精确捕获走受限 HTTP 路由，而不是修改用户的 Codex 全局设置。
- 透明转发 ChatGPT 订阅认证和客户端 header，但认证、账号以及 session/thread/turn/window 关联值只存在于内存中；Trace 仅保留相应 header 名称和脱敏占位符，禁止把原值写入 Trace、日志和诊断信息。
- 原始 zstd 字节直接转发；解压副本只进入受大小限制的 CaptureRecord。
- provenance 使用 `capture_proxy`，request/response fidelity 与关联置信度继续遵守现有 provenance v1。
- 协议不兼容或代理失败时，必须给出可解释错误并允许用户继续使用本地观察，不能破坏 Codex 本身。

## Viewer 信息层级

首版沿用 peekMyAgent 的三层查看方式：

1. **时间线**：只放用户理解任务过程所需的信息，包括用户输入、Assistant 回复、工具交换、子任务和压缩节点。
2. **整理视图**：按 Codex Responses 语义组织完整请求、Instructions、Harness 注入、Tools schema、Messages、tool calls/results、Response 和 Metadata。
3. **Raw**：保留对应来源的原始事件或重建后的 CaptureRecord，并明确标注 provenance。

Codex Responses 的首版分类规则：

- `input` 中 `role=developer` 的 message 进入 Instructions/Harness 注入；不把所有 developer 文本武断称为 system prompt。
- `additional_tools` 进入 Tools schema，并保留工具名、说明和参数 schema。
- `message` 按原始 role 和 content type 保持顺序，形成历史消息和当前输入。
- `custom_tool_call` / `custom_tool_call_output` 通过 `call_id` 关联为工具交换。
- `reasoning`、`response.completed`、usage、status 和错误保留为模型下行证据。
- rollout 与精确代理可以关联展示，但不互相覆盖；每个块继续携带自己的来源。

主导航按观察对象隔离 `Claude Code`、`Codex` 和 `OpenClaw`，一次只展示一类 Agent 的项目与会话。离线导入 Trace 保留独立入口，避免不同 Harness 的会话和术语混在一个列表中。

## 首版实施范围

- Codex Desktop 会话发现与 rollout 增量读取。
- rollout 事件到共享 Trace Domain 的归一化，未知事件保留 Raw。
- OpenAI Responses/Codex 请求与 SSE 回复归一化。
- `pma codex capture -- ...` 受管深度捕获入口，以及安全、可逆的失败处理。
- 现有 SQLite 内容寻址、渐进加载、导出/导入和翻译能力复用。
- 确定性 fixture 测试与一次隔离的真实多轮、成功工具调用闭环验证。

## 暂不承诺

- 默认接管用户已经打开的 Codex Desktop 网络连接。
- 修改系统证书或实施全局 TLS MITM。
- 把私有 first-party Responses 路由描述成长期稳定的公开 API。
- 首版完成 OTel 配置 UI、托管 App Server 或所有平台的文件监听优化。

## 待逐点讨论

以下问题先记录，不阻塞首版基础实现；需要产品取舍时一次只讨论一个：

首版精确代理只提供 `pma codex capture` CLI；Viewer 不提供会让用户误以为可以接管既有 Desktop 进程的开关。

1. rollout 与 proxy exact 同时存在时，时间线默认以哪一个为主证据。
2. developer 输入中，哪些稳定规则足以命名为“Codex 核心指令”“项目指令”“运行环境”和“临时 Harness 注入”。
3. 上下文压缩是作为独立 Turn 事件，还是作为前后上下文窗口之间的转换节点。
