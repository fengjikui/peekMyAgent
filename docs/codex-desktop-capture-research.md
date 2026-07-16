# Codex Desktop 捕获研究与实施路线

更新时间：2026-07-16

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

1. 对真实上游的透明 WebSocket 转发和 HTTP fallback。
2. model catalog、重连、取消、stream error 和代理崩溃恢复。
3. request/response 大小上限与 zstd 解压炸弹防护。
4. headers 全链路不落盘证明和自动化回归。
5. 用户配置漂移、多个 Codex 进程和旧配置恢复。
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
