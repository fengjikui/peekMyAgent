# Codex Desktop 捕获研究与实施路线

更新时间：2026-07-17

状态：实验结论，尚未实现为 peekMyAgent 的正式 Codex Desktop adapter。

本文回答一个产品问题：用户通常通过桌面图标启动 Codex，而不是通过 `pma` wrapper 启动 CLI。peekMyAgent 是否仍能捕获 Codex 的会话、工具、子 Agent、系统提示词和上下文压缩过程？

## 结论摘要

可以捕获，而且“从桌面图标启动”不是根本障碍。

Codex Desktop 会启动内嵌的 `codex app-server`，并持续维护 `$CODEX_HOME` 下的线程数据库、日志数据库和 rollout JSONL。peekMyAgent 可以在不接管桌面进程、不修改模型 URL、也不要求用户改变启动习惯的情况下，从这些本地来源恢复大部分语义 Trace：

- 用户消息、Assistant 消息、reasoning、工具调用和工具结果。
- Turn、thread、父子 thread 和子 Agent 关系。
- session metadata、工作目录、模型、版本和 resume 状态。
- 自动/手动上下文压缩事件、压缩窗口和替换后的历史。

但本地 rollout 观察不等于“网络层完整请求捕获”。如果用户需要逐字查看真正发给模型的完整请求、内置工具 schema 和 wire response，则需要显式启用更高权限的深度代理模式。

因此推荐四层产品结构：

1. **本地观察模式**：默认。只读数据库与 rollout，桌面图标启动也能自动发现。
2. **OTel 增强模式**：可选。补充请求时延、WebSocket/SSE、工具决策和工具结果遥测。
3. **深度捕获模式**：显式 opt-in。通过 `openai_base_url` 接管模型链路，获得完整 wire request。
4. **托管 App Server 模式**：独立入口。由 peekMyAgent 启动并持有一个 Codex app-server，适合未来的控制、发送和 IDE 集成，但不会透明接管用户已经打开的桌面会话。

## 实验环境

本轮实验只证明当前 macOS 安装的真实行为，不把具体路径或私有表结构视为永久 API。

| 项目 | 实验值 |
| --- | --- |
| Desktop bundle | `com.openai.codex` |
| Desktop app version | `26.707.72221` |
| Desktop build | `5307` |
| Desktop 内嵌 Codex | `0.144.2` |
| 全局 Codex CLI | `0.134.0` |
| 默认状态目录 | `$CODEX_HOME`，未配置时为 `~/.codex` |

桌面内嵌版本和用户全局 CLI 版本可以不同。正式 adapter 必须按数据生产者版本解析，不能假定全局 `codex` 就代表当前桌面运行时。

## 实验一：桌面进程与通信形态

### 方法

- 检查桌面主进程、子进程、启动参数和打开的文件。
- 检查 app-server 是否暴露 TCP、命名 Unix socket 或其他可附着端点。
- 对照当前内嵌版本生成的 app-server JSON Schema。

### 观察

桌面主进程会启动类似下面的子进程：

```text
codex -c features.code_mode_host=true app-server --analytics-default-enabled
```

当前 app-server 由桌面应用通过匿名 pipe/socketpair 持有，没有暴露可供第三方安全附着的稳定监听地址。桌面应用自身存在一个内部 IPC socket，但它属于未公开的 GUI 协议，不应成为开源产品依赖。

app-server 官方协议包含 thread、turn、item、tool、raw response item 和 `thread/compacted` 等事件，且可以为精确版本生成 JSON Schema。

### 结论

- 不能把“附着到已经运行的桌面 app-server”作为默认方案。
- 可以在未来提供由 peekMyAgent 自己启动 app-server 的托管模式。
- 对用户已打开的桌面会话，默认方案应读取其本地持久化证据，而不是劫持私有 IPC。

## 实验二：本地数据库与 rollout JSONL

### 方法

- 以只读方式检查 `$CODEX_HOME` 下的状态数据库、日志数据库和 session 文件。
- 观察 thread、父子关系、动态工具和活跃 rollout 的写入。
- 对长会话只读取尾部窗口并统计事件形状，不输出用户正文。

### 观察

状态数据库保存：

- thread id、rollout 路径、source、model、cwd、title、token 和 Codex version。
- `parent_thread_id -> child_thread_id` 的显式 spawn edge。
- thread 级动态工具名称、描述和 input schema。

rollout JSONL 保存：

- `session_meta`
- `turn_context`
- `response_item`
- `event_msg`
- `world_state`
- `compacted`

`response_item` 覆盖消息、reasoning、function/custom tool call 和 tool output。`event_msg` 还包含用户消息、Agent 消息、token、任务、补丁和 Web 搜索等事件。

活跃 session 文件可能在写入期间被替换或重新创建。正式 watcher 不能永久持有一个 inode 或假定路径永不消失；它应监听父目录、处理 rename/delete/recreate，并在需要时重新从状态数据库解析 rollout 路径。

### 结论

本地状态足以构建 Codex Desktop 的默认语义时间线，也能稳定区分多个 thread 和子 Agent。它不需要 wrapper，因此适合普通用户的桌面启动习惯。

数据库表和 JSONL event shape 仍属于版本相关实现。adapter 必须：

- 只读访问，不修改 Codex 数据。
- 记录生产者版本。
- 保留未知事件，避免新版本字段被静默丢弃。
- 用版本化 parser/fixture 管理兼容性。

## 实验三：模型可见输入

### 方法

使用内嵌版本执行：

```bash
codex debug prompt-input "<non-sensitive probe>"
```

只统计 message role、content type、字符数和 hash，不保存完整正文。

### 观察

该命令返回按顺序排列的 developer/user 输入，并包含：

- 运行规则和 developer instructions。
- 仓库级 `AGENTS.md`。
- 环境上下文。
- 当前用户输入。

它非常适合解释“Codex 在这一轮如何组装模型可见输入”，但输出不包含完整内置工具 schema，也不是网络层 request body。

### 结论

`debug prompt-input` 可作为显式诊断动作或托管模式中的“Prompt assembly 快照”，不能单独承担持续 Trace 捕获，也不能标记为 wire exact。

## 实验四：上下文压缩机制

### 方法

- 在长 rollout 尾部搜索 `compacted` 和 `context_compacted`。
- 比较压缩前后的 event 顺序、window id 和 replacement history。
- 不读取或提交真实对话正文。

### 观察

一次压缩通常表现为：

```text
普通 response/tool events
  -> token_count
  -> compacted
  -> world_state
  -> turn_context
  -> token_count
  -> context_compacted notification
```

`compacted` 包含：

- `window_id`
- `previous_window_id`
- `window_number`
- `first_window_id`
- `replacement_history`
- `message`

实验样本中的 `replacement_history` 是一组新的 ResponseItem 历史，不只是“删除旧消息”或“写入一段纯文本摘要”。它通常保留大量 message item，并带一个专门的 compaction item；部分压缩内容可能是加密或不透明结构。

原始 rollout 仍保留此前事件和每个压缩窗口，因此可以同时展示：

- 压缩前发生过什么。
- 压缩后 Codex 使用了哪一组替代历史。
- 多次压缩窗口如何通过 id 串联。

### 结论

Codex 的上下文压缩更适合呈现成“窗口演进”：

```text
Window 142
  原始历史  ->  compacted replacement history
                         |
                         v
Window 143
```

Viewer 不应把它简化成一条普通用户消息，也不应声称已经解密或还原不可见的 compaction 内容。

## 实验五：OTel 增强

### 方法

为一次隔离、临时的内嵌 Codex 执行配置本机 loopback OTLP HTTP receiver：

```text
[otel]
environment = "pma-codex-research"
log_user_prompt = false
exporter = { otlp-http = { endpoint = "http://127.0.0.1:<port>/v1/logs", protocol = "json" } }
```

### 观察

收到的事件包括：

- `codex.conversation_starts`
- `codex.api_request`
- `codex.websocket_request`
- `codex.sse_event`
- `codex.user_prompt`
- `codex.tool_decision`
- `codex.tool_result`
- 首 token 时延和阶段性 timing

`log_user_prompt=false` 时用户 prompt 默认脱敏。但工具参数和工具输出仍可能出现在 tool 事件属性中。

### 结论

OTel 适合补充时序和运行决策，不适合替代完整请求捕获：

- 能解释何时连接、何时收到事件、工具何时获批和完成。
- 不能稳定给出完整 system/developer input 和全部工具 schema。
- 即使 prompt 已脱敏，工具参数与输出仍可能包含源码、路径和隐私数据。

产品必须显式说明隐私边界，并在修改 `[otel]` 配置后提示用户重启 Codex，因为运行时在进程启动时读取配置。

## 补充实验：系统代理

图标启动的 Desktop 网络进程会遵循操作系统代理设置，因此“不是从命令行启动”并不会让网络流量天然不可路由。

但普通 HTTP tunnel proxy 通常只能看到目标域名、连接和流量大小。TLS request body 仍然加密，除非实施自定义 CA/TLS interception。Codex 虽然提供 `CODEX_CA_CERTIFICATE` 和 `SSL_CERT_FILE` 等证书配置入口，但系统级 MITM 会扩大到更多域名和应用，也会增加证书、隐私和故障恢复风险。

结论：系统代理适合网络可达性诊断，不应作为 peekMyAgent 默认的完整内容捕获机制。

## 实验六：显式 Base URL 深度捕获

### 方法

为一次隔离的内嵌 Codex 临时设置：

```text
openai_base_url = "http://127.0.0.1:<local-proxy>/v1"
```

本机 receiver 只记录安全的 shape、大小和字段名，不记录认证值或用户正文。实验结束后立即停止 receiver。

这一轮 receiver 为了阻止请求继续访问真实服务端，故意返回 `502`。因此实验六只证明 Codex 会把完整请求和订阅态 headers 发送到显式 Base URL，不证明真实上游能够被透明转发。真实转发闭环见实验七。

### 观察

配置被真实采用，Codex 依次访问：

- `GET /v1/models?client_version=...`
- WebSocket upgrade `/v1/responses`
- 必要时回退 `POST /v1/responses`

HTTP request body 使用 zstd 压缩。解压后的请求包含：

- `input`
- `model`
- `reasoning`
- `prompt_cache_key`
- `tool_choice`
- `parallel_tool_calls`
- `client_metadata`
- `stream`

当前 first-party 请求没有把工具统一放在顶层 `tools`；内置工具以 `input` 中的 `additional_tools` developer item 注入，其中包含工具名称、描述和 JSON schema。实验确认可见 shell、文件、计划、MCP、Web、图像和多 Agent 协作工具。

认证、账号、线程和客户端 metadata 会经过该代理。它们不得写入日志或持久化 Trace。

### 结论

完整 wire capture 在技术上可行，但它是高敏感、高兼容成本的显式模式：

- 代理必须同时支持 model catalog、WebSocket Responses 和 HTTP fallback。
- 必须支持 zstd 请求体、流式 response 和 first-party `additional_tools`。
- 必须透明转发认证头，但绝不能保存或展示认证值。
- 必须绑定 loopback，并提供可逆配置、异常退出恢复和明确的用户同意。
- Codex/ChatGPT 服务端协议、attestation 或客户端约束变化都可能影响兼容性。

系统级 TLS MITM 虽然也可能看到流量，但会扩大到其他应用和域名，不应成为 peekMyAgent 的默认产品方案。

## 实验七：ChatGPT 订阅态透明转发闭环

### 目标

补齐实验六缺少的最后一段证据：让桌面 App 内嵌 Codex 的真实请求经过 loopback 探针，再发往它原本使用的模型服务，并确认模型回复能够无损返回 Codex。实验同时分别验证 WebSocket 主通道和 HTTP streaming fallback。

### 真实上游地址

本机 `codex-cli 0.144.2` 的当前日志显示，ChatGPT 订阅态 Codex 使用的 first-party 服务是：

- model catalog：`https://chatgpt.com/backend-api/codex/models?client_version=0.144.2`
- HTTP Responses：`https://chatgpt.com/backend-api/codex/responses`
- WebSocket Responses：`wss://chatgpt.com/backend-api/codex/responses`
- compaction：`https://chatgpt.com/backend-api/codex/responses/compact`
- search：`https://chatgpt.com/backend-api/codex/alpha/search`

它不是公开 API 的 `https://api.openai.com/v1/responses`。订阅认证不能被当作 API key 改投另一个端点。

探针只允许下面的精确路径映射：

```text
/v1/models             -> /backend-api/codex/models
/v1/responses          -> /backend-api/codex/responses
/v1/responses/compact  -> /backend-api/codex/responses/compact
/v1/alpha/search       -> /backend-api/codex/alpha/search
```

### 安全约束

- 探针只绑定 `127.0.0.1`，不接受非白名单路径。
- `authorization`、`chatgpt-account-id`、`session-id` 和 `thread-id` 只在内存中透传；日志只记录 header 名称和“是否存在”，不记录值。
- zstd 正文的原始压缩字节直接转发；单独解压副本只做字段、数量和大小统计，不输出文本。
- response 只计状态码和字节数并流式回传，不保存 response body。
- Codex 使用 `--ephemeral`、只读 sandbox 和固定无工具提示词，不读取项目文件；实验结束后关闭监听并确认没有独立 rollout 文件。
- `openai_base_url` 通过单次 `-c` 参数覆盖，没有修改用户 `config.toml`。

### 首次失败与根因

探针第一次使用 Node.js `https.request()` 直接连接 `chatgpt.com:443`，得到 `ETIMEDOUT`，真实上游尚未返回 HTTP 状态码。

本机通过 loopback HTTP(S) 代理访问外网；`curl` 会读取系统/环境代理，而 Node.js 的 `https.request()` 默认不会自动使用 `HTTPS_PROXY`。因此失败发生在网络路径，不是订阅认证、目标 URL 或 request schema。

修复方式是：探针先向已配置的 HTTP proxy 发送标准 `CONNECT chatgpt.com:443`，再在 tunnel 内以 `chatgpt.com` 为 SNI 完成 TLS 和证书校验。探针不实施 TLS MITM，也不改变真实目标域名。

正式实现需要同时支持：

1. `HTTPS_PROXY` / `https_proxy` 与操作系统代理发现；
2. HTTP `CONNECT` 和必要时 SOCKS；
3. `NO_PROXY` 与 loopback 例外；
4. 代理认证不落盘、不进入诊断日志；
5. 跨 macOS、Windows、Linux 的一致行为与可解释错误。

### HTTP fallback 结果

探针主动拒绝本地 WebSocket upgrade，让 Codex 在完成重试后使用 HTTP streaming fallback。真实结果：

| 步骤 | 结果 |
| --- | --- |
| `GET /backend-api/codex/models?client_version=0.144.2` | `HTTP 200`，281,116 bytes |
| `POST /backend-api/codex/responses` | `HTTP 200`，101,312 bytes |
| Codex 最终消息 | 精确返回 `PMA_SUBSCRIPTION_PROXY_OK` |
| Codex 进程 | exit code `0` |

该次 `/responses` 请求仍为 zstd：36,862 bytes 压缩、96,158 bytes 解压；顶层字段为 `client_metadata`、`include`、`input`、`model`、`parallel_tool_calls`、`prompt_cache_key`、`reasoning`、`store`、`stream`、`text` 和 `tool_choice`。样本含 7 个 input item，其中 5 个 developer、2 个 user；`additional_tools` 中有 4 个工具定义。上述数字是单次实验 shape，不是稳定协议常量。

### WebSocket 结果

第二轮让探针透明转发 WebSocket upgrade 和后续二进制帧，不解析或持久化 frame payload。真实结果：

| 步骤 | 结果 |
| --- | --- |
| model catalog | `HTTP 200` |
| TLS | 证书校验通过，ALPN `http/1.1` |
| `wss://chatgpt.com/backend-api/codex/responses` | `HTTP/1.1 101 Switching Protocols` |
| Codex 最终消息 | 精确返回 `PMA_WEBSOCKET_PROXY_OK` |
| Codex 进程 | exit code `0` |

### 结论

当前版本中，使用 ChatGPT 订阅登录的 Codex 可以通过显式 loopback Base URL 完成真实透明转发，不需要额外 API key。成立条件是：

- 请求必须回到当前真实的 `chatgpt.com/backend-api/codex/*` 路由，而不是公开 API 路由；
- 必须保留订阅认证、账号、session/thread 和 Codex 客户端 headers，同时重写 `Host` 并正确校验 `chatgpt.com` TLS；
- 必须支持 WebSocket、HTTP fallback、model catalog、zstd 和流式回传；
- 必须继承用户已有的上游网络代理，否则在部分网络环境中会表现为连接超时；
- 这是当前 `0.144.2` 的实验证据，不是服务端私有协议的长期兼容承诺。

官方配置文档确认 `openai_base_url` 是 built-in OpenAI provider 的代理/路由入口，`-c` 可以做单次运行覆盖。产品化时应优先使用可逆、会话级配置，并在协议或网络条件不满足时安全降级到本地观察，而不是持久修改用户配置或让 Codex 无法继续工作。

## 实验八：连续多轮与工具调用闭环

### 目标

实验七证明了单轮请求可以通过 ChatGPT 订阅态真实转发。实验八进一步验证两个产品关键点：

1. 同一个 Codex thread 连续 resume 时，后续请求是否携带此前的用户消息和 Assistant 回复；
2. 模型发起工具调用后，本地工具结果是否会被准确放入下一次完整请求，并最终得到模型续答。

### 方法

实验在隔离的只读临时目录中使用同一个 thread 完成以下阶段：

1. 第一轮要求模型记住一个一次性暗号并返回固定确认文本。
2. 第二轮不重复暗号，只要求模型回忆前一轮内容。
3. 后续轮要求模型通过 shell 工具真实执行 `wc -c`，再依据工具结果返回固定格式文本。

探针继续主动拒绝 WebSocket，使 Codex 回退到可审计的 HTTP streaming Responses 通道。每次 `/responses` 交换分别保存原始 zstd request、解压 JSON、原始 SSE、解析事件和不含认证值的 metadata。真实 Trace 只保留在 Git 忽略的本机临时目录，没有提交到仓库。

### 结果

| 验证点 | 结果 |
| --- | --- |
| thread 连续性 | 所有轮次使用同一 thread id |
| 第二轮历史 | 完整 request 同时包含第一轮 user message 和 Assistant 确认文本 |
| 无提示回忆 | 模型准确返回第一轮暗号 |
| 工具下发 | 第一次 `/responses` 的 SSE 返回 `custom_tool_call`，工具名为 `exec` |
| 本地执行 | Codex 执行指定 `wc -c` 命令并获得 exit code `0` 和真实字节数 |
| 结果回传 | 下一次 `/responses` request 包含相同 `call_id` 的 `custom_tool_call` 与 `custom_tool_call_output` |
| 最终回复 | 模型依据回传结果返回预期固定文本 |
| 上游状态 | 关键 `/responses` 请求均为 HTTP 200 |
| 认证落盘 | 只保存 header 名称和存在性；Bearer/JWT 值未进入 request、response 或 metadata 文件 |

工具阶段确实是两次模型交换，而不是 Codex 在本地直接生成最终答案：

```text
完整历史 + 本轮用户要求
  -> /responses
  <- custom_tool_call(exec, call_id)
  -> Codex 本地执行命令
  -> 完整历史 + custom_tool_call + custom_tool_call_output
  -> /responses
  <- 最终 Assistant 文本
```

实验还保留了一次工作目录错误：模型下发的命令成功转发，但本地执行返回 `No such file or directory`；该错误文本随后也被完整放入 `custom_tool_call_output` 并送回模型。修正启动目录后，同一 thread 的下一轮工具闭环成功。这说明深度捕获不仅能复盘成功工具调用，也能准确复盘“模型决策正确、Harness 执行环境错误”的失败链路。

### 结论

在当前 Codex `0.144.2` 和当前 first-party 协议下，显式 loopback Base URL 已经能够观测完整的多轮上下文与工具闭环：历史消息、工具调用参数、调用标识、执行结果和最终模型回复都可以关联。正式 adapter 仍必须把协议版本、来源和失败降级写清楚，不能把这次实验证据描述成长期稳定的公开 API 契约。

## 能力矩阵

| 能力 | 本地观察 | `debug prompt-input` | OTel | 深度代理 | 托管 app-server |
| --- | --- | --- | --- | --- | --- |
| 桌面图标启动后自动发现 | 是 | 否 | 需提前配置并重启 | 需提前配置并重启 | 否，独立会话 |
| 用户/Assistant 时间线 | 是 | 单次输入快照 | 部分 | 是 | 是 |
| 工具调用/结果 | 是 | 否 | 是 | 是 | 是 |
| 子 Agent/thread 血缘 | 是 | 否 | 部分 | 可结合本地状态 | 是 |
| 压缩窗口与替代历史 | 是 | 否 | 只有事件 | 可结合本地状态 | 有通知 |
| developer/system-like 输入 | 部分 | 是 | 否 | 是 | 取决于协议事件 |
| 完整内置工具 schema | 否 | 否 | 否 | 是 | 取决于协议和动态工具 |
| 精确 wire request/response | 否 | 否 | 否 | 是 | 否 |
| API/WebSocket/timing | 粗粒度 | 否 | 是 | 是 | 有生命周期事件 |
| 默认隐私风险 | 低到中 | 中 | 中 | 高 | 中 |

“部分”必须在 UI 中展示来源和证据边界，不能伪装成 exact request。

## 推荐实现路线

### Phase 1：Codex Desktop 本地观察

这是首个可发布版本，目标是零配置兼容桌面图标启动。

建议模块边界：

```text
src/adapters/codex-desktop-discovery.mjs
src/adapters/codex-rollout-normalizer.mjs
src/core/codex-rollout-events.mjs
src/server/codex-rollout-watch-service.mjs
```

具体职责：

1. 发现 `$CODEX_HOME`、Desktop 内嵌 Codex 版本和状态文件。
2. 只读加载 thread catalog、rollout path 和 spawn edges。
3. 对活跃 JSONL 做 offset/cursor 增量读取。
4. 处理文件 rename、delete、recreate、resume 和 archive。
5. 将已知事件映射到共享 Trace Domain，未知事件保存在 Raw evidence。
6. 为数据声明独立 provenance，例如 `codex_rollout_local`，明确不是网络层原始 request。
7. 复用现有大 Trace cursor、分页、内容寻址存储和 Viewer 时间线。

首版 UI 应优先解释：

- 当前 thread、Turn 和工作目录。
- 用户输入、Assistant 回复、reasoning、工具和结果。
- 子 Agent 的父子 thread 与事件顺序。
- 压缩前后窗口。
- 每一块数据来自 rollout、state DB、OTel 还是 wire proxy。

### Phase 2：OTel 增强

提供显式的 `pma codex enable-otel` / `disable-otel` 类入口，最终命令名在实现时再做用户测试。

要求：

- 备份并可逆修改用户级配置。
- 默认 `log_user_prompt=false`。
- 明示工具参数/输出仍可能含敏感数据。
- 只发送到 loopback receiver。
- 与本地 rollout 按 thread/turn/call id 合并，不覆盖本地原始证据。
- 配置变更后明确提示重启 Codex。

### Phase 3：深度捕获

只面向需要完整 system prompt、tool schema 和 wire body 的高级用户。

要求：

- 独立开关和风险确认，不与默认观察混为一谈。
- 修改前备份，退出/崩溃后可恢复 `openai_base_url`。
- 支持 WebSocket 和 HTTP Responses、zstd、model catalog 和流式 response。
- headers 只在内存中转发，禁止持久化认证信息。
- body 落盘继续复用 peekMyAgent 的内容寻址、大小限制、脱敏和导出风险预览。
- provenance 明确标记为 `proxy_exact`，并分别记录正文 fidelity 与 response association confidence。

### Phase 4：托管 App Server

由 `pma` 启动与 Desktop 版本匹配的 app-server，并成为它的正式 client。该模式适合：

- 页面直接发送并进入同一受控 thread。
- 获得结构化 lifecycle notification。
- IDE/自动化集成。
- 精确管理 thread、turn 和 interrupt。

它不是对用户已经打开的 Codex Desktop 会话进行透明接管，产品文案必须说明这是一个由 peekMyAgent 管理的独立运行模式。

## 后续实验清单

在实现 Phase 1 前，至少补齐：

1. 新 thread、resume、fork、archive 和删除后的文件/数据库变化。
2. 手动 compact 与自动 compact 的结构是否一致。
3. 三个并行子 Agent、子 Agent 多轮工具调用和父子 thread 完成顺序。
4. rollout 写入期间的 rename/recreate 以及 Desktop 异常退出恢复。
5. 多项目、多窗口和多个同时运行的 Desktop thread。
6. 0.134、0.144 及后续版本的 event/schema fixture 对比。
7. 2 GiB 级 rollout 的增量索引、首屏延迟、内存和 CPU gate。
8. Windows/Linux 可用 Codex 形态下的 `$CODEX_HOME`、文件监听和锁行为。

在实现深度代理前，至少补齐：

已补齐：真实上游的 WebSocket 与 HTTP fallback 透明转发闭环，以及同 thread 多轮历史和成功/失败工具结果回传闭环。

仍需补齐：

1. model catalog、重连、取消、stream error 和代理崩溃恢复。
2. request/response 大小上限与 zstd 解压炸弹防护。
3. headers 全链路不落盘证明和自动化回归。
4. 用户配置漂移、多个 Codex 进程和旧配置恢复。
5. 上游 HTTP/SOCKS/system proxy 的三平台发现、认证和失败诊断。
6. First-party 协议变化后的失败降级，不影响用户继续使用 Codex。

## Phase 1 验收标准

- 用户从桌面图标启动 Codex 后，不执行额外 wrapper，peekMyAgent 能发现新 thread。
- 新事件在合理延迟内增量出现，不重复、不乱序、不需要重读整个 JSONL。
- resume、子 Agent 和 compact 能形成可解释的 thread/Turn/window 关系。
- 2 GiB rollout 不做全文件 `JSON.parse`，首屏成本与可见窗口相关。
- 默认模式不修改 Codex 配置、不接触认证文件、不转发网络流量。
- UI 对每种数据标明 provenance，不把 rollout 语义 Trace 称为完整 wire request。
- adapter 遇到未知版本或未知事件时保留 Raw，并安全降级，而不是丢失整条会话。

## 官方接口参考

- [Codex advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced)
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Codex app server](https://learn.chatgpt.com/docs/app-server.md)
