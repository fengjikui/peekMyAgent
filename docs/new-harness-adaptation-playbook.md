# 新 Harness 适配工作手册

更新时间：2026-07-24

状态：**活文档 / 设计与验收基线**。本文描述接入一个新 Harness 时必须完成的调查、实现和验证工作，不代表某个具体 Harness 已经支持。OpenCode CLI 的首轮验证计划见 [OpenCode CLI 适配计划](opencode-cli-adaptation-plan.md)。

## 1. 目标

peekMyAgent 接入新 Harness 的目标不是“能在左侧显示一个新名称”，而是让用户能够：

1. 看见 Harness 发给模型的真实上行、模型真实下行以及二者的关联证据；
2. 区分 wire 原始证据、本地语义事件和 PMA 推断结果；
3. 阅读 System、Tools schema、Harness 注入、History、当前 Message、Response、工具调用与工具结果；
4. 追踪多轮、工具闭环、压缩、resume 和子 Agent；
5. 使用翻译、搜索、导入导出、分块缓存和大 Trace 渐进加载；
6. 在不破坏原 Harness 配置、凭据和退出行为的前提下完成捕获；
7. 在新增适配器后继续保证 Claude Code、Codex、OpenClaw 和既有来源行为不回归。

## 2. 不变量

任何新适配器都必须遵守以下不变量。

### 2.1 证据不能伪装

捕获能力按证据强度排序：

1. **精确代理**：真实转发模型 HTTP 请求与回复；
2. **Harness 官方原始遥测**：包含真实 request/response body，但可能缺失或改变关联字段；
3. **Harness 本地 API / event stream**：能说明会话和工具生命周期，但不自动等价于模型 wire body；
4. **本地会话/rollout 导入**：能重建语义时间线，但不自动证明线上请求的逐字内容；
5. **启发式推断**：只用于补充关联和分类，必须显示置信度和限制。

`CaptureRecord.provenance` 必须分别声明 request/response artifact fidelity 与 association confidence。Viewer 不得根据 Agent 名称、文件来源或“看起来完整”来猜证据等级。

### 2.2 Agent 差异停在边界

Harness 特有逻辑应集中在：

- `src/adapters/`：可执行文件、版本、配置、认证存在性、启动与恢复、代理覆写和清理；
- `src/core/`：共享进程、平台、代理、路径和 provenance 基础设施；
- `src/trace/`：经过 fixture 证明后才能进入的协议和语义规则；
- Adapter 自己的 fixture、contract smoke 和真实集成说明。

不应在以下位置新增散落的 `if (agent === "...")`：

- Viewer renderer；
- HTTP route；
- Source repository；
- 通用翻译 collector；
- 通用 protocol/response parser。

如果新 Harness 使用已支持的 Anthropic、OpenAI Chat 或 OpenAI Responses 协议，应复用共享解析；只有真实 fixture 证明存在新协议形态时，才扩展共享协议层。

### 2.3 配置必须进程级、可逆、最小化

默认策略：

- 优先使用子进程环境变量、临时 profile 或官方 runtime override；
- 不修改用户主配置和认证文件；
- 不复制、打印或持久化 API key；
- 只覆写当前选中 provider/model 所需的 base URL；
- 成功、失败、超时、SIGINT/SIGTERM 都执行同一幂等清理；
- wrapper 透传 stdin/stdout、退出码和信号。

若只能修改持久配置，必须先设计字节级备份、drift 检测、恢复命令和崩溃恢复，再进入实现。

### 2.4 共享产品能力不能降级

新来源进入共享 Trace Domain 后，必须显式评估：

- Source/项目/会话导航；
- 首屏与 cursor 渐进加载；
- Turn 和上下行交错；
- System、Tools、Harness、History、Message、Response、Metadata、Raw；
- tool call/result 配对；
- subagent graph；
- 翻译材料、缓存和搜索；
- Trace 导入导出和脱敏；
- i18n；
- rename/archive/delete 与 watch 清理。

不支持的能力要通过 capability 声明隐藏或解释，不能展示一个会失败的按钮。

## 3. 适配前的证据包

在写运行时代码前，先建立一个只读、可复查的 Evidence Pack。

### 3.0 调研任务的模型与上下文预算

调研可以并行，但应按难度分级：

- 路径、版本、help、文件清单和测试清单等机械事实使用轻量模型；
- subagent 默认不继承完整项目对话，只提供当前问题、必要路径和预期输出；
- 协议证据判断、架构边界和最终整合由主贡献者完成；
- 不让多个 subagent 重复通读整个仓库；
- 只有出现跨模块冲突或证据无法解释时，才升级模型或扩大上下文。

这样既控制成本，也减少旧对话对当前仓库事实的干扰。

### 3.1 产品和版本事实

记录：

- 官方项目、许可证和文档；
- 本机可执行文件真实路径与版本；
- CLI help、TUI/run/server/attach 等运行形态；
- 支持的平台和安装方式；
- 配置、数据、日志、session 和认证文件路径；
- provider/model 选择与 base URL 覆写入口；
- continue/resume/session/fork 语义；
- 权限模型、工具、Skill/Plugin、子 Agent 和压缩机制。

所有易漂移事实必须写明调查日期和验证版本。

### 3.2 最小实验矩阵

使用无敏感内容的临时项目，至少采集：

| 实验 | 要回答的问题 |
| --- | --- |
| 首轮普通消息 | System、Tools、Harness 注入和用户输入位于哪里 |
| 连续两轮 | 历史如何回传；会话 ID 和请求关联是否稳定 |
| 一次只读工具调用 | 模型 call、Harness 执行、tool result 和最终回复怎样交错 |
| permission ask/deny | 中断、拒绝和重试是否产生模型请求或本地事件 |
| resume/continue | 会话与 watch 如何复用；request index 是否连续 |
| Skill/command/plugin | 能力目录和加载正文何时注入 |
| compaction/summarize | 压缩由本地还是模型完成；原始请求是什么 |
| subagent | 父子身份、子请求、回流和终态如何关联 |
| 模型/provider 切换 | 协议路径、header、请求体和 response 是否变化 |
| 失败/取消/信号退出 | 配置、端口、进程和 watch 是否干净恢复 |

一个未完成的实验必须保留为“未知”，不能靠相似 Harness 的行为补齐。

### 3.3 Fixture 规则

Fixture 必须：

- 来自真实协议或可证明等价的 mock；
- 在进入仓库前人工脱敏；
- 不包含真实 key、cookie、认证 header、源码、用户提示词、绝对路径和账户 ID；
- 保留协议结构、动态 tool 类型、流式边界、usage 和 stop reason；
- 标注来源、Harness 版本、provider 协议、实验场景和已删除字段；
- 覆盖首轮、多轮、工具闭环和错误响应；有能力时再补 Skill、压缩和子 Agent。

### 3.4 Harness 注入的识别规则

“它看起来像提示词”不是分类证据。System、Developer、Harness 注入、slash command 和用户正文可能共用同一种协议 role，也可能混在同一个 content block 中。适配器必须先保存原始位置和内容，再按以下证据顺序建立额外投影：

1. 协议中明确的 `system` / `developer` role 或官方独立字段；
2. 真实 fixture 证明的命令 envelope、command name、message metadata 或生命周期事件；
3. 真实 fixture 证明的、结构完整且在该 Harness 中有稳定语义的标签；
4. 版本受控的精确模板指纹；
5. 无法证明时保留为普通 Message 或 `unknown`，不得靠语气、关键词或泛化 XML 正则升级为 Harness。

分类结果应保留：

```text
kind / subtype / projected_role
source_path / source_range
evidence_type / evidence_value
confidence
raw block reference
```

展示遵循“来源不搬移、语义可投影”：

- Developer 默认独立于 Harness；只有内部经过验证的注入子块额外投影到 Harness；
- slash command 只有在原生命令 envelope、metadata 或精确模板可证明时才投影到 Harness；
- slash 的原始 message 继续保留在 History/Message，不能因为投影而消失；
- `/compact` 等命令生成的 summary 仍属于压缩后的 History，不因命令来源而重复复制到 Harness；
- Tools schema 属于上行参考，不属于模型 Response；
- 当前模型下行中的 tool call 属于 Response，只有下一次发给模型的 tool result 才属于上行；
- organized view 可以去除重复投影，Raw、History 和原始 Response 不得去重或改写。

每增加一种 marker 或 slash 模板，必须同时增加：

1. 一个真实脱敏正例；
2. 一个用户正文讨论相同标签或命令的反例；
3. 一个结构损坏、嵌套或未知标签的边界例；
4. 对 History/Message/Harness/Raw 四个范围的断言。

### 3.5 Codex 适配复盘

Codex 的 CLI、rollout、Desktop 和精确代理适配暴露了以下可复用问题。新 Harness 的实现和评审必须逐项检查，而不是等 UI 出错后再补规则。

| 现象 | 根因 | 可复用规则 | 必须具备的回归 |
| --- | --- | --- | --- |
| rollout 看起来像完整请求 | 本地记录只有 observed upstream delta 和重建 downstream | artifact fidelity 与 association confidence 分开；exact、partial、missing 不互相升级 | 同一会话 exact proxy 与本地记录的 Raw、来源文案和 capability 不同 |
| 多轮或压缩后 History/Message 错位 | 用上一请求总消息数充当当前切分下标 | 使用当前来源提供的 reused prefix/delta 证据；没有证据就显示未知 | 普通复用、零复用、压缩后首条输入、replacement history |
| 当前 tool call 重复出现在上行 | 混淆模型下行 call 与下一次上行 result | call 属于 Response；result 属于下一次 request | 跨请求 call/result 配对，当前上行不含当前 response call |
| 结构化工具发现结果为空或只剩摘要 | 把动态工具目录当普通文本 | 保存完整工具名、描述、schema 和参数说明；摘要只作预览 | 多 namespace、长 schema、缺字段及 Raw/整理一致性 |
| Tools schema 看起来像模型返回 | 请求详情、Response 详情和参考信息共用 DTO | 上下行 DTO 分开；Response 中的 Tools 只能标为“上行参考” | 完整请求无 response 派生字段，Response 仍可查对应 Tools reference |
| 普通 Developer 被标成 Harness | 按 role、关键词或任意标签猜测 | Developer 独立展示；只投影白名单强证据子块 | 普通 Developer、白名单、未知和嵌套同名标签 |
| slash 原文消失或重复 | 把额外投影误做成来源搬移 | Harness 可投影，History/Message 必须保留原文 | `/compact`、未知 slash、双层 command envelope、replacement history |
| 精确捕获绑定到错误会话 | provider override 只在会话创建或冷恢复时生效 | 明确配置生效时机；未命中目标只能报告“尚未捕获” | 并行会话、项目不匹配、resume、fork、重复启动 |
| 真实 Desktop 重启打断发布门禁 | 把破坏性生命周期实验放进默认 gate | 自动 gate 只跑 fake relay/session；真实重启为显式手工矩阵 | 默认测试证明不启动真实 Desktop，手工报告记录精确 SHA |
| 子 Agent 永久显示运行中或串错 | 把 spawn 尝试当成功实例，或只按相邻顺序关联 | 需要稳定 child id/task name/metadata；终态来自明确 result/notification | spawn 失败、跨请求 child activity、回流、取消、旧新版终态 |
| Harness 通知和 tool result 重复完成 | 同一事实的两种证据被当成两个事件 | 原生 tool result 为主事实；通知保留在 Harness 证据 | 两者同时存在、仅一方存在、call id 不匹配 |
| exact 与本地语义记录相互覆盖 | 按会话合并值，而不是按 artifact/provenance 关联 | 来源可并列关联，不得覆盖；每块保留 origin/fidelity/scope | 同一会话双来源下 Raw、范围和置信度仍独立 |
| relay 扩大本地攻击面 | 未限制绑定、帧、大小和方法 | 仅 loopback、有界解析、白名单改写、认证只在内存 | 非 loopback、非法帧、超限 payload、未知方法 |

这些问题形成三个总原则：

1. **先证明信息从哪里来，再讨论怎样组织。**
2. **Raw 保存事实，Trace Domain 建立关系，Viewer 只消费显式 DTO。**
3. **任何“更聪明”的整理都必须有反例，且不能删除原始证据。**

## 4. 适配器验收问题清单

以下内容是评审时必须回答的问题，不是要求立即实现的 SDK 接口。首个 OpenCode 适配可以先用显式模块实现；只有第二个新 Harness 证明多个实现出现真实重复后，才抽取稳定接口。

```text
identity
  id / displayName / executable names / supported versions

discovery
  executable / effective config / project root / provider / model
  auth presence only (never auth content)

launch
  new session / resume / fork / non-interactive / server attach
  argv pass-through / cwd / stdio / signal / exit code

capture
  supported modes / default mode / provenance
  route rewrite / request decode / response decode / size limits

attribution
  watch / project / conversation / request
  parent and subagent hints / confidence

protocol
  Anthropic / OpenAI Chat / OpenAI Responses / other
  request and response variants / streaming

semantics
  System / Tools / Harness markers / messages
  tool calls and results / compact / Skill / subagent lifecycle

capabilities
  proxy / telemetry / resume / composer / translation
  subagent graph / export / live update

cleanup
  config restore / temp files / ports / child processes
  test sessions and captures
```

在代码中可以从最小的 `adapter descriptor + focused helpers` 起步。只有第二个新 Harness 证明多个实现重复后，才抽象稳定 SDK 接口。

## 5. 实现顺序

### 阶段 A：只读发现

1. 发现可执行文件和版本；
2. 读取官方配置层级，不读取 secret 内容；
3. 识别项目根、provider/model、协议候选和 session 操作；
4. 产出 doctor 信息与 unsupported 原因；
5. 建立 Evidence Pack。

退出条件：不发付费模型请求，也能说明“能否安全适配、用什么捕获方式、还缺什么证据”。

### 阶段 B：隔离的精确代理实验

1. 启动 loopback mock upstream；
2. 用官方 runtime override 只改当前子进程；
3. 验证路径、headers、压缩、流式 response 和错误传播；
4. 证明真实 provider 可被字节级转发；
5. 记录 capture provenance 和敏感 header 脱敏规则。

退出条件：真实 provider 实验成功，或者得到明确的“不支持精确代理”证据并选择次级来源。

### 阶段 C：CLI wrapper

1. 新建或复用 watch；
2. 生成临时 override；
3. 启动真实 Harness 并继承终端；
4. 捕获、归属并增量持久化；
5. 退出后清理临时状态、停止 watch 并保留 Trace；
6. 支持 new/resume/fork 的稳定语义。

### 阶段 D：共享 Trace 接入

按顺序扩展：

1. `request-profile` 和 protocol fixture；
2. `model-response-normalizer`；
3. `content-parts` 与 `tool-call-semantics`；
4. `message-semantics` 和 Harness marker；
5. Turn、context delta 和 subagent graph；
6. `ViewerTraceProjector`、Source capabilities 和 evidence profile。

每一步先补 contract fixture，再改共享模块。禁止先在 Viewer HTML 中“做出看起来正确的结果”。

### 阶段 E：产品能力

- 左栏按 Harness/项目/会话分组；
- 请求时间线按真实上行/下行交错；
- Raw 显示来源与证据等级；
- System/Tools/Harness/History/Message/Response 范围正确；
- 翻译 provider 策略明确使用当前 Harness 或显式不可用；
- 翻译块、搜索、复制、重译和缓存复用共享契约；
- 大 Trace 使用 cursor 和 detail lazy loading；
- import/export 和清理覆盖新 Agent。

### 阶段 F：发布与回归

OpenCode 一类 CLI/进程/代理改动属于高平台风险，必须执行 Level 2：

1. 聚焦 contract 和 fake-wrapper E2E；
2. 当前平台完整 release profile；
3. GitHub Actions macOS/Windows/Linux 同一 SHA 全绿；
4. 真实 macOS、Windows、Linux 候选 SHA 验证；
5. Claude Code、Codex、OpenClaw 最小真实闭环；
6. architecture、codebase map、manual smoke matrix、README/help 和中英文 UI 同步。

回归选择必须根据本次实际触及的共享边界决定，而不是只运行名称相似的 smoke：

| 触及边界 | 追加回归 |
| --- | --- |
| Capture Proxy / provenance | Claude proxy、Codex exact、OpenClaw proxy |
| process / signal / wrapper | Claude、Codex CLI、OpenClaw wrapper 的正常、非零和清理 |
| request/response normalizer | 各协议 fixture、普通消息、多轮和工具闭环 |
| message/tool/subagent semantics | Claude/Codex/OpenClaw 对应语义 fixture 与 Viewer projector |
| Source/Viewer DTO | persisted/live/imported Source 与 detail/cursor Viewer E2E |
| translation | 各已知 Agent provider policy、材料、缓存、搜索与中英文 i18n |

## 6. 测试矩阵

### 6.1 新适配器

| 层级 | 必须覆盖 |
| --- | --- |
| 纯逻辑 | 配置路径、参数透传、base URL、归属、脱敏、恢复幂等 |
| 协议 contract | System/Tools/messages、tool call/result、stream、usage、stop reason、provenance |
| Fixture | 首轮、多轮、工具闭环、错误；可选 Skill/compact/subagent |
| 确定性 E2E | fake executable + mock upstream + 隔离 HOME；正常、非零、SIGINT、端口和清理 |
| Viewer E2E | normalize → SQLite → repository → projector → Viewer detail/translation |
| 真实账号 | 普通消息、多轮、只读工具、resume、权限、异常退出 |

### 6.2 既有适配器回归

共享模块改变时至少覆盖：

- Proxy/provenance/request profile/model response；
- content parts/message semantics/tool semantics/Viewer projector；
- Claude wrapper 和 OTel；
- Codex exact proxy 与 Viewer integration；
- OpenClaw isolated profile、wrapper 和 cleanup；
- 翻译材料、缓存、i18n 和 Trace bundle。

会重启 Codex Desktop 的真实测试不得进入默认全量 gate。

## 7. 安全和隐私检查

- daemon、Viewer 和 proxy 默认只绑定 loopback；
- 不记录 authorization、cookie、API key 或完整认证文件；
- 日志、错误、doctor 和证据报告必须脱敏；
- 配置发现只报告路径、provider id、字段存在性和 hash；
- request/response 大小限制不能因新适配器被绕过；
- 测试使用隔离 HOME、state dir、配置目录、npm cache 和随机端口；
- 导出是“降低误分享风险”，不是自动无敏；
- 页面发送能力必须单独声明，不能因为可以捕获就默认允许发消息；
- 任何全局配置接管都必须显式 opt-in、可预览、可恢复。

## 8. Main 合入门槛

新 Harness 进入 `main` 前必须具备：

1. 明确的 capture mode、provenance 与限制；
2. 至少一套真实脱敏 fixture；
3. config contract、protocol contract、fake-wrapper E2E 和 Viewer E2E；
4. 正常、失败、取消和信号退出的幂等清理；
5. 既有 Agent 最小回归；
6. 当前平台 release profile 与三平台 hosted CI；
7. 至少一份真实账号/真实二进制验证报告；
8. 用户安装、启动、resume、停止、清理和隐私说明；
9. architecture、codebase map、manual smoke matrix 与 i18n 同步；
10. 无配置漂移、残留进程、残留测试 Source 或敏感 fixture。

## 9. 什么时候把它固化成 Skill

现在不立即创建 Skill。先把本文作为项目内、受 Git 审查的活文档，原因是：

- OpenCode 的真实协议、配置覆写和子 Agent 证据尚未完全验证；
- 过早 Skill 化容易把暂时结论伪装成固定流程；
- 项目文档可以和代码在同一 PR 中保持同步。

满足以下条件后再生成 `peekmyagent-harness-adapter` Skill：

1. OpenCode CLI 已按本文完整走完一轮；
2. 第二个 Harness（例如 Hermes 或 Pi）验证了哪些步骤真正通用；
3. adapter descriptor、fixture 目录、测试命令和清理脚本已经稳定；
4. Skill 只保留稳定入口，易漂移的 Harness 事实继续链接项目文档；
5. Skill 有一组正反例，能检查“证据伪装、配置污染、Viewer 分叉”等常见错误。

## 10. 文档同步责任

实现期间：

- 当前事实写入 `docs/architecture.md`；
- 文件与所有权写入 `docs/codebase-map.md`；
- 未完成工作写入 `docs/refactoring-roadmap.md`；
- 真实实验及限制写入 Harness 专属计划/证据文档；
- 用户命令写入 README/help；
- 可见文案同时更新中英文 i18n。

PR 评审时要逐项核对文档与代码；计划行为不得写成已实现行为。
