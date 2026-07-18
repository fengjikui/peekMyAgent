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

## Desktop-first 统一入口（已实现）

默认入口不再要求用户先从历史 Codex thread 中选择观察对象。启动语义与 Claude Code wrapper 保持一致，但交互界面优先尊重 Codex 用户以 Desktop 为主的真实习惯：

- `pma codex`：以当前工作目录为项目，打开 Codex Desktop 和对应的 peekMyAgent 看板，建立一个“等待新会话”观察对象；默认目标是在 Desktop 中创建并自动绑定一个新 thread，用户仍在 Codex Desktop 的原生对话框中输入消息。
- `pma codex -c` / `pma codex --continue`：绑定当前工作目录最近一次可读 thread，并打开对应 Desktop 工作区。
- `pma codex --resume <thread-id>`：观察明确指定的 Codex thread，并打开其工作区；当前只保证观察绑定，不承诺让已经运行的 Desktop 自动切换到该 thread。
- 默认工作目录来自执行命令时的 `cwd`；后续可以补充显式目录参数，但不以全量扫描、导入用户全部 Codex 历史作为启动前提。
- 模型、推理等级、权限和审批策略默认不由 PMA 覆盖，优先沿用 Codex Desktop/App Server 自身默认值。后续可暴露少量明确参数，但不能复制一套容易与 Codex 漂移的设置系统。
- 现有历史 thread 选择保留为高级的只读观察入口，不再作为默认首次体验；受管 CLI TUI 也保留为高级模式，而不是默认入口。

捕获策略 `auto` 当前会明确回退到只读 rollout 语义观察，并在命令行和看板标明 provenance。用户显式选择 `proxy`/`exact` 时直接给出可解释错误并引导使用 `pma codex capture -- ...`，不能静默伪装成精确捕获；显式选择 `rollout` 时只读取 `$CODEX_HOME` 中绑定 thread 的增量事件。

技术事实是：平台原生 launcher 可以把一个目录交给 Desktop 打开，但现有 Desktop 进程持有自己的私有 app-server stdio 连接，不会自然继承 `pma codex capture` 为 CLI 子进程注入的一次性 provider。macOS 使用 `com.openai.codex` Bundle ID，而不是可能触发大体积安装下载的内置 `codex app`。因此当前实现采用“Desktop 原生交互 + 自动绑定单一 rollout”的可靠路径，并保持模型/权限由 Desktop 继承；不通过全局配置污染、系统级 TLS MITM 或跨平台 UI 自动化强行实现。

等待对象在选择文件中只保存稳定 Source ID、工作区、启动时 thread 基线、捕获模式和回退原因。Source catalog 发现同工作区第一条基线外可读 thread 后原地绑定；rollout 正文不进入 peekMyAgent SQLite。

Codex 特殊标签已采用白名单分类：运行时、能力、策略、内部目标、生命周期和子 Agent 事件进入 Harness 整理视图，并复用现有 marker/hash 翻译缓存；Raw 仍保留原始 role、标签、顺序和 provenance，未知标签不猜测。

## 暂不承诺

- 默认接管用户已经打开的 Codex Desktop 网络连接。
- 修改系统证书或实施全局 TLS MITM。
- 把私有 first-party Responses 路由描述成长期稳定的公开 API。
- 首版完成 OTel 配置 UI、托管 App Server 或所有平台的文件监听优化。

## 待逐点讨论

以下问题先记录，不阻塞首版基础实现；需要产品取舍时一次只讨论一个：

首版精确代理只提供 `pma codex capture` CLI；Viewer 不提供会让用户误以为可以接管既有 Desktop 进程的开关。

1. rollout 与 proxy exact 同时存在时，时间线默认以哪一个为主证据。
2. 上下文压缩是作为独立 Turn 事件，还是作为前后上下文窗口之间的转换节点。
