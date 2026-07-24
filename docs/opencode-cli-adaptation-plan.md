# OpenCode CLI 适配计划

更新时间：2026-07-24

状态：**研究与实施计划，尚未实现 OpenCode 捕获**。当前仓库没有 `pma opencode`、OpenCode adapter 或 OpenCode smoke。通用流程和验收门槛见 [新 Harness 适配工作手册](new-harness-adaptation-playbook.md)。

## 1. 产品目标

首版只适配 OpenCode CLI/TUI，不处理 OpenCode Desktop。

期望体验：

```bash
cd /path/to/project
pma opencode
```

PMA 应在当前项目启动 OpenCode TUI，保持 OpenCode 原生 stdin/stdout、权限、模型选择和命令体验，同时打开或打印对应 dashboard URL。用户在 OpenCode 中进行普通对话、多轮、工具、Skill、压缩和子 Agent 操作时，PMA 捕获当前进程的 Trace。

原生参数应直接透传，例如：

```bash
pma opencode --continue
pma opencode --session <session-id>
pma opencode --fork --continue
pma opencode --model <provider/model>
pma opencode --agent <agent>
pma opencode --auto
```

首版默认捕获当前 wrapper 启动的进程，不接管所有 OpenCode 会话，不扫描或复制用户既有会话。

## 2. 当前证据

### 2.1 官方文档声明

以下内容来自 2026-07-24 的 OpenCode 官方文档。它们是设计输入，不是本机运行时证据；实现提交仍需记录目标版本、真实 help、fixture 和实验输出。

- `opencode` 默认启动 TUI；支持 `--continue`、`--session`、`--fork`、`--model`、`--agent`、`--auto` 和 `--port`。
- `opencode run` 提供非交互模式和 JSON event 输出，并支持 attach 到现有 server。
- `opencode serve`/server API 提供 session、message、child session、event、command 和 summarize 等语义接口。
- 配置按 remote、global、custom、project、`.opencode`、inline、managed 顺序合并；`OPENCODE_CONFIG_CONTENT` 是 runtime override。
- 项目配置从当前目录向上查找到最近 Git 根。
- provider 可通过 `options.baseURL` 覆写。
- OpenCode 使用 AI SDK/Models.dev；OpenAI-compatible provider 可能使用：
  - `@ai-sdk/openai-compatible` → `/v1/chat/completions`
  - `@ai-sdk/openai` → `/v1/responses`
- 认证通常位于 `~/.local/share/opencode/auth.json`；PMA 不应读取或复制其内容。
- Skills 由原生 `skill` 工具按需加载，模型先在工具说明中看到可用 Skill 的名称和描述。
- subagent 由 Agent/task 能力和权限控制；server API 可以观察 child sessions。
- compaction 提供 `auto`、`prune`、`reserved` 等配置，server 有 summarize 操作。

官方参考：

- [CLI](https://opencode.ai/docs/cli/)
- [Config](https://opencode.ai/docs/config/)
- [Providers](https://opencode.ai/docs/providers)
- [Server API](https://dev.opencode.ai/docs/server/)
- [Agents](https://opencode.ai/docs/agents/)
- [Permissions](https://opencode.ai/docs/permissions)
- [Agent Skills](https://opencode.ai/docs/skills/)

### 2.2 本机只读验证快照

2026-07-24 在 macOS arm64 上只读确认：

- OpenCode `1.18.4` 由 Bun 全局安装，入口位于 `~/.bun/bin/opencode`；
- `opencode` 默认启动 TUI，并在根命令支持 `--continue`、`--session`、`--fork`、`--model`、`--agent`、`--auto` 和 `--port`；
- `opencode run` 支持 `--format default|json`、`--attach` 以及同类 session/model/agent 参数；
- `session` 子命令的当前 help 只列出 `list` 和 `delete`；resume/fork 是根命令或 `run` 参数，不应被设计成 `session resume`；
- `debug paths` 报告 config/data/cache/state/log 和 SQLite DB 均位于标准用户目录；
- 当前非敏感 provider 配置使用 `@ai-sdk/openai-compatible` driver；provider id、base URL 和认证内容不写入公共证据文档；
- 当前 shell 未设置 `OPENCODE_*` 或 `XDG_*` runtime override；
- 本次没有读取认证内容、日志正文，没有发模型请求，也没有创建会话。

### 2.3 尚未证实

下列内容不能在实现前当作事实：

- effective config 的完整合并结果和嵌套字段语义；
- `OPENCODE_CONFIG_CONTENT` 在 `1.18.4` 上对 project/managed config 的真实覆盖关系；
- 当前 driver 的实际 endpoint、headers、stream、错误和取消传播；
- TUI 首次请求前的稳定 session identity；
- server event 与 wire request 的确定关联键；
- child session、Skill、summarize/compact 与真实模型交换的对应关系。

## 3. 最重要的架构结论

### 3.1 OpenCode 不是一种固定 wire 协议

OpenCode 的 provider 配置决定模型请求可能是 Anthropic、OpenAI Chat、OpenAI Responses 或其他 AI SDK provider 形态。因此：

- 不创建一个假定固定 request schema 的 `opencode-normalizer`；
- adapter 负责发现和覆写当前 provider 的 base URL；
- Capture Proxy 保留真实 path/body/response；
- 共享 `request-profile` 和 `model-response-normalizer` 再根据真实证据判断和解析协议；adapter 不解释展示语义；
- 新协议必须先加入脱敏 fixture，再扩展共享 Trace 模块；
- 未知协议保持 Raw 可见并标为 unsupported，不伪装成完整整理结果。

### 3.2 精确代理是默认来源，本地 server/event 是语义补充

CLI wrapper 的默认目标是 exact proxy。OpenCode server/event API 可以补充：

- session id；
- parent/child session；
- permission 和 tool lifecycle；
- command/summarize 生命周期。

但这些语义事件不自动等价于模型 wire request。二者需要独立 provenance，后续再按稳定 identity 合并。

当前尚无 server event 与 wire capture 的 identity 实证，也没有 child session、summarize 或 Skill lifecycle 的关联证据。在这些实验完成前，server/event 只能作为独立语义来源显示，不能宣称已确定合并。

### 3.3 不修改用户主配置

优先方案是：

1. 读取 effective provider/model 的非敏感配置；
2. 用 `OPENCODE_CONFIG_CONTENT` 注入仅当前子进程生效的 provider baseURL override；
3. 继续让 OpenCode 自己从原位置读取认证；
4. 子进程退出即失效，无持久配置恢复负担。

实现前必须通过 mock 和真实 provider 实验证明：

- inline config 的深度合并语义；
- provider/model 级 `npm` 与 `baseURL` 不会被意外覆盖；
- project config、managed config 是否可能阻止 runtime override；
- OpenCode 是否把 baseURL 解释为 API 根还是完整 endpoint；
- Chat Completions/Responses/Anthropic 三类 path 的转发规则。

若 runtime override 不能可靠工作，才评估临时 custom config；不得直接 patch 全局或项目配置。

## 4. 建议的实现边界

### 4.1 OpenCode adapter

建议新增：

```text
src/adapters/opencode/
  discovery.mjs
  config-overlay.mjs
  runtime.mjs
  capabilities.mjs
```

也可以在首个小提交中使用更少文件，但职责必须保持：

- `discovery`：可执行文件、版本、cwd/project、provider/model、协议候选；
- `config-overlay`：构造进程级 runtime override，不含 secret；
- `runtime`：启动、watch、proxy、stdio、信号、退出和幂等清理；
- `capabilities`：new/resume/fork/proxy/server-events/translation/subagent 等显式能力。

provider-specific path/header/body 规则只有在真实 fixture 证明共享 Proxy 无法处理时才增加；展示语义继续由共享 Trace Domain 所有。

平台差异放在 `src/core/platform.mjs`、`app-paths.mjs` 或 `process-tools.mjs`，不散落在 adapter 和 CLI。

### 4.2 CLI

`bin/peekmyagent.mjs` 当前仍是较大的入口。OpenCode 不应继续复制整段 Claude/OpenClaw lifecycle。

首版应先抽一个最小共享 wrapper runner，至少统一：

- argv/cwd/stdin/stdout；
- watch start/reuse/stop；
- dashboard URL；
- child exit code 与 signal；
- cleanup stack；
- 临时环境覆盖；
- 错误诊断脱敏。

只抽 OpenCode 实现真正需要、且能由现有 Claude/OpenClaw 行为测试证明的部分。不要借机重写整个 CLI。

### 4.3 Trace 与 Viewer

硬性边界：OpenCode adapter 只能产出 Capture/provenance/capability/Trace Domain 可消费的 DTO。Server 负责装配服务，Viewer 只消费共享 DTO。不得为 OpenCode 在 `src/viewer/server.mjs`、SourceRepository、Viewer API route、`client.js` 或 renderer 中新增 Agent/provider 条件分支。

默认复用：

- `CaptureRecord` 与 provenance；
- Persistence content blobs；
- SourceRepository；
- request profile；
- content parts；
- tool call/result semantics；
- model response normalizer；
- ViewerTraceProjector；
- Raw/History/Message/Response；
- 翻译材料、缓存、搜索和 Trace bundle。

只有真实 OpenCode fixture 证明差异时，才修改：

- Harness marker 白名单；
- compact/summarize 生命周期；
- subagent identity；
- OpenCode 特有动态 tool call 类型；
- Source capability 和 Agent 文案。

## 5. 需要完成的实验

### E0：本机只读发现

输出一份不含 secret 的报告：

- `which/type -a opencode`、真实路径、版本；
- `opencode --help`、`run --help`、`session --help`、`models --help`；
- effective config 层级和路径；
- 当前 provider/model id 与 npm driver；
- 认证“存在/不存在”，不输出值；
- session 存储、project id、日志和 server API；
- 支持的 runtime override 环境变量。

### E1：配置合并与恢复

使用隔离 HOME 和 fake provider：

1. global/project/inline 分别设置不冲突和冲突字段；
2. 验证 `OPENCODE_CONFIG_CONTENT` 最终合并；
3. 验证只改 baseURL，不丢 model、permissions、agents、plugins 和 tools；
4. 正常、非零、SIGINT 后用户文件 hash 不变。

### E2：协议与字节转发

分别验证至少两个 provider driver：

- OpenAI Chat；
- OpenAI Responses；
- 若当前真实配置使用 Anthropic，再补 Anthropic。

记录：

- path、method、content encoding、stream format；
- 保留/移除哪些 hop-by-hop headers；
- auth 只在内存转发；
- request/response size limit；
- upstream error、429、断流和取消传播；
- captured artifact 与 forwarded bytes 的关系。

### E3：普通多轮

连续两轮回答：

- session id 是否在 request 或本地 API 中可见；
- History 和 Message 差分是否正确；
- request index 是否连续；
- complete response、usage、stop reason 是否完整；
- resume 后是否复用同一 Source 或建立可解释的新 watch。

### E4：工具闭环

使用只读命令，例如查看当前目录：

```text
用户上行
→ 模型下行 tool call
→ OpenCode 执行
→ tool result 上行
→ 模型最终回复
```

验证主时间线交错、call id 配对、Raw 和整理视图一致。

### E5：Skill 与 command

- 模型最初看到的是 Skill 清单还是完整正文；
- `skill` 调用的工具参数和结果；
- Skill 正文随后如何进入上下文；
- slash command/project instruction/plugin 注入如何标为 Harness；
- 不把用户正文中的同名 XML/Markdown 误判为注入。

OpenCode 首轮实验按[工作手册中的 Harness 注入识别规则](new-harness-adaptation-playbook.md#34-harness-注入的识别规则)记录每个候选块的：

- 原始 role、content index 和 JSON path；
- 是否有 command envelope、metadata 或本地 lifecycle event；
- 标签是否结构完整、是否在不同轮次和版本中稳定；
- 同一文本是否仍保留在 History/Message；
- 用户正文包含同名 slash/tag 时是否会被误判。

首版只允许“实验证明的白名单 marker + 明确命令 envelope”。单纯以 `/` 开头、包含 `system`/`skill`/`agent` 关键词、使用 XML/Markdown 或位于 `developer` role，都不足以单独判定 Harness 注入。

E5 只是观测实验，不属于 M1/M2 承诺。若没有稳定 wire/event 证据，首版只显示 Raw/unknown，不增加 Skill 专用 API 或 Viewer 分支。

### E6：压缩

- 自动压缩触发点；
- summarize 是否产生独立模型 request；
- 被保留/裁剪的 message；
- prune 与 summary 的区别；
- 压缩后首条 request 的 History/Message；
- 本地 lifecycle event 与模型 HTTP 交换分别记录。

### E7：子 Agent

- task tool 的 call/result；
- child session id 和 parent id；
- 子 Agent 是否独立发模型请求；
- 多个 child 如何区分；
- child tool calls/results；
- return/failure/cancel；
- server events 与 wire capture 如何用确定 identity 关联。

没有稳定 identity 时，先显示独立请求和“可能关联”证据，不建立高置信分支。

### E8：失败与清理

- provider/model 不存在；
- auth 不存在；
- 端口占用；
- proxy 上游失败；
- OpenCode 非零退出；
- Ctrl+C/SIGTERM；
- wrapper 崩溃后的 doctor；
- 无残留临时配置、进程、端口、watch 和测试 Source。

## 6. 分阶段交付

### M0：证据和设计

- 本文及 Evidence Pack；
- 本机 OpenCode 版本事实；
- 配置合并、协议和 session 实验结论；
- 明确 unknowns。

### M1：确定性骨架

- `pma opencode` 命令解析与 help；
- fake OpenCode + mock upstream；
- 进程级 config overlay；
- watch/proxy/退出/清理；
- 不接真实账号。

### M2：真实 exact proxy

- 一个真实 provider 的普通多轮与工具闭环；
- 脱敏 fixture；
- provenance、Source 和 Raw；
- 默认不支持的协议显式报错。

### M3：Viewer 完整能力

- System、Tools、Harness、History、Message、Response；
- 翻译、搜索、复制和缓存；
- 大 Trace 渐进加载；
- export/import；
- OpenCode 独立 Source 分组。

### M4：可选机制扩展

- Skill；
- compaction；
- subagent；
- server semantic events 与 wire evidence 合并。

四项彼此独立，分别要求 fixture、provenance 和必要的 identity contract。server event 的存在本身不能证明模型 wire 语义。

### M5：发布

- 当前平台 Level 2；
- 三平台 hosted CI；
- Windows/Linux 真实机器；
- Claude/Codex/OpenClaw 最小真实回归；
- README/help/architecture/manual matrix/i18n；
- npm candidate 验证。

## 7. 测试设计

建议新增：

```text
smoke:opencode-config-contract
smoke:opencode-protocol-fixtures
smoke:run-opencode
smoke:opencode-viewer-integration
```

聚焦复用：

```text
smoke:proxy-openai
smoke:proxy-attribution
smoke:provenance-contract
smoke:request-profile-contract
smoke:message-semantics-contract
smoke:tool-call-semantics-contract
smoke:model-response-normalizer-contract
smoke:viewer-trace-projector-contract
smoke:viewer-translation-adapter-contract
smoke:viewer-i18n-contract
```

既有 Agent 最小回归：

```text
smoke:run-claude
smoke:daemon-claude
smoke:claude-settings-env
smoke:codex-exact-proxy
smoke:codex-exact-viewer-integration
smoke:run-codex-capture
smoke:run-openclaw
smoke:openclaw-profile-cleanup
smoke:normalize
```

这些命令是候选入口，不是固定套餐。实际回归由改动边界决定：

| 改动 | 至少增加的真实/确定性行为 |
| --- | --- |
| wrapper/process | Claude、Codex CLI、OpenClaw 的正常退出、非零退出与清理 |
| Proxy/provenance | 三类来源普通消息和一轮 exact capture |
| protocol normalizer | 受影响协议的多轮、tool call/result 和 complete response |
| semantics/projector | 既有来源 Timeline、History/Message/Response 与 Viewer detail |
| translation | 已知 Agent 的 provider 选择、材料、缓存和 i18n |

会重启 Codex Desktop 的测试不得加入默认 gate。真实 OpenCode 账号测试进入 `docs/manual-integration-smoke-matrix.md`，不进入无凭据 release gate。

## 8. 翻译策略

当前翻译 provider policy 只明确识别 Claude Code 和 Codex。OpenCode 接入时必须同时解决：

1. Source 明确标记 `agent_profile=OpenCode`；
2. 优先使用 OpenCode 可用的低成本模型/低 reasoning 配置；
3. 不得因为 OpenCode 翻译不可用而静默启动 Claude CLI；
4. 未配置 provider 时显示可行动的诊断，不读取认证文件内容；
5. System、单工具 description、单 schema field、单 Harness 注入继续复用共享 block hash；
6. 同一原文跨 Source 可复用全局翻译块，History 只按会话内内容复用。

翻译实现属于 M3；M1/M2 可以先声明 capability 不可用，避免伪装成功。

## 9. 关键未知项

开始写真实 adapter 前必须关闭以下问题：

- 当前安装版本和源码 commit；
- inline config 对嵌套 provider/model 的真实 merge 语义；
- 如何可靠获知当前 effective provider/model/npm driver；
- baseURL 对不同 driver 的拼接规则；
- TUI 首次请求前能否拿到稳定 session id；
- continue/session/fork 对本地 session 和 wire identity 的影响；
- server event 与 provider request 的稳定关联键；
- child session 与子 Agent wire request 的关联键；
- compaction 的真实 request 和生命周期；
- plugin/custom tool 是否增加新的动态 call 类型；
- managed config 是否可能禁止 runtime override；
- OpenCode 更新导致协议漂移时的版本 gate。

未知项应在实验报告中逐条关闭。不能为了尽快显示 UI 而用启发式答案代替。

## 10. 完成定义

以下全部是**目标与验收条件，当前尚未实现**。

OpenCode CLI 适配“可合入”意味着：

- 用户可以从任意项目目录运行 `pma opencode`；
- 原 OpenCode 交互、权限、模型和退出码不变；
- 默认只捕获该进程，不接管历史会话；
- 至少一个真实 provider 的多轮和工具闭环是 exact wire；
- Viewer 能准确区分原始证据、语义事件和推断；
- System/Tools/Harness/History/Message/Response 和 Raw 范围正确；
- 配置、认证、端口、进程、watch 和测试 Source 清理通过；
- 翻译不可用时不错误回退到别的 Agent；
- 新适配器和既有 Agent 的聚焦回归、当前平台 release profile、三平台 CI 全绿；
- 当前事实、限制、用户命令和验证 SHA 已写入文档。
