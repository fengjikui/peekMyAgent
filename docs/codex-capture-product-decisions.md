# Codex 捕获首版产品决策

状态：首版已实现。本文记录当前范围、证据边界和后续仍需逐点讨论的产品取舍；已实现行为同步记录在 `docs/architecture.md`。

## 产品目标

让使用 Codex Desktop 或 Codex CLI 的用户，在不改变日常工作习惯的前提下，看清一次任务中的用户输入、上下文组装、模型回复、工具调用与结果、子任务以及上下文压缩。需要完整系统提示词和工具 schema 的用户，可显式启用深度捕获。

## 两种捕获模式

### 本地观察

- 作为明确的无重启/历史查看模式，只读 `$CODEX_HOME` 中的 thread catalog 与用户显式选择的一个 rollout JSONL。
- 首次使用由用户选择一条会话，之后只保留 thread id 作为观察引用；不把 Codex 历史正文复制进 peekMyAgent SQLite。
- 切换观察对象只是更换只读引用，不修改 Codex 配置，不接触认证信息，不转发网络流量。
- 展示用户/Assistant 消息、reasoning 摘要、工具调用与结果、Turn、子 thread 和压缩事件。
- provenance 使用 `codex_rollout_local`。它是 Codex 自己保存的语义事件，不等同于网络层完整请求。

### 精确代理

- 由用户显式启动受管 Codex CLI 或 Codex Desktop 会话，用于查看真正发送到模型服务的 Responses 请求与回复。
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
- `pma codex ...` 默认受管深度捕获入口，以及安全、可逆的失败处理；旧的 `capture --` 形式保留为兼容别名。
- `pma codex desktop` 的 macOS 受管 App Server、双 capability relay、重启同意、自中断保护和正常恢复。
- 现有 SQLite 内容寻址、渐进加载、导出/导入和翻译能力复用。
- 确定性 fixture 测试与一次隔离的真实多轮、成功工具调用闭环验证。

## Proxy-first 统一入口（已实现）

peekMyAgent 是用户主动启动的观察工具，不是默认常驻的生产监控。用户显式执行捕获命令时，逐字的模型 request/response 比完全无感的 Desktop 交互更重要。因此默认入口与 Claude Code wrapper 一致，优先启动可逆的精确代理；Desktop rollout 保留为显式语义观察入口。CLI 的隔离边界是子进程，Desktop 的隔离边界进一步收窄为用户选择的一条 thread 链。这个默认值也避免把核心捕获能力绑定到 Codex 的本地持久化实现：即使未来 rollout 被压缩、裁剪、按需关闭或调整格式，受管 thread 发出的真实请求仍可在网络边界被观察：

- `pma codex [Codex args...]`：在当前工作目录启动受管 Codex CLI，只为该子进程注入 HTTP-only Responses provider，并默认打开精确 Trace 看板。
- `pma codex resume --last` / `pma codex resume <thread-id>`：使用 Codex 原生命令恢复会话，同时继续走进程级精确代理。
- `pma codex exec "..."`：执行一次非交互任务并捕获精确链路。Codex 参数直接透传；`-c` 保持其原生“配置覆盖”含义，不再作为 PMA continue 缩写。
- `pma codex desktop`：在受支持的 macOS build 上默认启动托管精确捕获；只把当前工作区随后新建的第一条 thread 路由到 Capture Proxy，其他 Desktop thread 保持原 provider。Desktop 已运行时先请求重启同意，能力不可用时 `auto` 才明确退回 rollout。
- `pma codex desktop --capture rollout`：不重启 Desktop，打开等待中的看板并绑定该工作区随后创建的第一条新 thread。
- `pma codex desktop -c` / `--resume <thread-id>` / `--select`：默认提供只读 rollout 历史观察；显式加 `--capture exact` 时，在重启后的 App Server 中只为所选 thread 的冷恢复注入捕获 provider。`--list` 只列候选会话。
- 默认工作目录来自执行命令时的 `cwd`；后续可以补充显式目录参数，但不以全量扫描、导入用户全部 Codex 历史作为启动前提。
- 模型、推理等级、权限和审批策略默认不由 PMA 覆盖，Codex 参数和用户配置仍是唯一设置来源；PMA 只在目标 thread 的创建/冷恢复请求上覆盖 provider route。
- 现有历史 thread 选择保留为高级入口，无论 rollout 观察还是 exact 冷恢复都只保存 thread id，不复制用户全部 Codex 历史。

精确代理只允许经过真实转发实验验证的 first-party Codex 路由，并保持认证和用户配置不落盘。显式 `--capture exact` 若启动或真实上游失败，会把错误原样返回，不会静默换成 rollout；默认 `auto` 只在平台/版本能力不可用或用户拒绝重启时明确解释并转入 rollout。Desktop 历史子命令只读 `$CODEX_HOME` 中绑定 thread 的增量事件，并在命令行和看板标明 provenance。

技术事实是：现有 Desktop 进程持有启动时建立的 app-server 连接，不能在运行中接收新的进程环境。当前 macOS 实现因此在用户同意后优雅重启 Desktop，使用 bundle 内嵌、版本匹配的 app-server 和 tokenized loopback relay，再把 app-server 的模型流量送进现有 Capture Proxy。它不污染全局配置、不实施系统级 TLS MITM，也不宣称能原地附着任意既有进程。实现和威胁边界见[托管 Codex Desktop 精确捕获](codex-desktop-managed-exact-capture.md)，实验依据见 [Codex Desktop App Server Bridge 实验](experiments/codex-desktop-app-server-bridge-2026-07-19.md)。

thread 级配置实验限定了最终形态：`modelProvider` 可以在 `thread/start`、冷态 `thread/resume` 或 `thread/fork` 时选择，但不能对仍被 Desktop 订阅的已加载 thread 热切换。当前 relay 已使用方法白名单、有界 WebSocket 解析和内存态 request/response 关联，仅对用户选中的 thread 注入捕获 provider；其他 thread 继续使用用户原 provider。选择既有 thread 后仍需在重启后的 Desktop 中打开它，触发冷恢复；未发生改写时产品必须明确报告“尚未捕获”。

等待对象在选择文件中只保存稳定 Source ID、工作区、启动时 thread 基线、捕获模式和回退原因。Source catalog 发现同工作区第一条基线外可读 thread 后原地绑定；rollout 正文不进入 peekMyAgent SQLite。

Codex 特殊标签已采用白名单分类：运行时、能力、策略、内部目标、生命周期和子 Agent 事件进入 Harness 整理视图，并复用现有 marker/hash 翻译缓存；Raw 仍保留原始 role、标签、顺序和 provenance，未知标签不猜测。

## 暂不承诺

- 默认接管用户已经打开的 Codex Desktop 网络连接。
- Windows/Linux 上的 Codex Desktop 托管精确重启；平台边界已经集中到 adapter，但尚未宣称支持。
- 修改系统证书或实施全局 TLS MITM。
- 把私有 first-party Responses 路由描述成长期稳定的公开 API。
- 首版完成 OTel 配置 UI 或所有平台的文件监听优化。

## 待逐点讨论

以下问题先记录，不阻塞首版基础实现；需要产品取舍时一次只讨论一个：

精确代理由默认 `pma codex` 提供；旧的 `pma codex capture -- ...` 只作为迁移期兼容别名。Viewer 不提供会让用户误以为可以接管既有 Desktop 进程的开关。

1. rollout 与 proxy exact 同时存在时，时间线默认以哪一个为主证据。
2. 上下文压缩是作为独立 Turn 事件，还是作为前后上下文窗口之间的转换节点。
