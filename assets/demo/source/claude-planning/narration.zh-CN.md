# 《一个用户请求为什么会变成七次模型往返》中文旁白母稿

本稿是 Claude Code 机制系列第五章的中文事实母稿。实验使用当前安装的 Claude Code 2.1.220 真实 CLI，通过 PMA 连接确定性本地 Anthropic 假上游。真实的是 Harness 生命周期、工具执行、上行请求形态和 PMA 解析；模型回复是固定的公开测试文本，不代表真实 Claude 模型能力。

- 总时长草案：约 04:34
- 画面：中文 Viewer、Claude 主题、2048×1056 原始帧
- 任务：只读检查两个很短的公开文件，维护任务状态，再给出三条建议
- 证据：4 个 Turn、10 次真实 CLI 请求；最后一个 Turn 内有 7 次 Request
- 隐私：只使用 Blue Lantern 虚构项目、通用临时路径和本地假上游；原始请求不进入 Git

## 教学合同

观众看完后应该能复述：

> 远端模型不会直接读取文件或更新任务。它只能根据 Claude Code 发来的上下文和工具定义，返回文本或结构化 `tool_use`。Claude Code 在本地执行工具，再把 `tool_result` 放进下一次用户消息。一次用户请求因此可能展开成多次模型 Request。PMA 用 Turn 和 Request 两级导航保留整个闭环，并让用户分别检查 History、当前 Message、协议顺序和最终回答。

本章演示 Claude Code 的 `TaskCreate`、`TaskUpdate`、`Read` 和 `TaskGet`，不把它们与 `EnterPlanMode`、`ExitPlanMode` 混为一谈。模型回复来自确定性假上游，只用来驱动真实 Claude Code 执行可重复的 Harness 流程。

## 00:00–00:14　一个请求，为什么需要七次往返

画面：标题卡，不显示大段字幕框。

旁白：

用户只发出一个多步请求，Claude Code 为什么会和模型往返七次？任务清单是谁创建的，文件又是谁读取的？这一次我们不只看最终答案，而是沿着每次 Request，把模型、Harness 和本地工具的分工逐层拆开。

## 00:14–00:36　场景保持简单，机制必须完整

画面：完整三栏时间线。编号 1 先标出三个铺垫 Turn；编号 2 后出现，标出真正执行任务的 Turn 4。两项共同保留，因为要比较准备阶段和执行阶段。

旁白：

演示项目叫 Blue Lantern，只有 README 和一页快速指南。前三轮只确定项目名、只读边界和证据要求。第四轮才提出完整任务：建立清单，读取两个文件，更新状态，再给三条建议。业务内容很简单，观众不需要先理解陌生项目；我们把注意力全部留给 Agent 机制。

## 00:36–00:54　Turn 找任务阶段，Request 找内部往返

画面：Turn 4 顶部的 Request Rail。编号 1 先聚焦七个刻度；编号 2 再聚焦下方请求链。编号 1 保留，因为下方每一段都对应上方一个刻度。

旁白：

选择 Turn 4 后，第二级 Request Rail 出现。顶部七个刻度对应 Request 4 到 Request 10；下方时间线则显示每次工具调用、结果回传和模型回复。第一层 Turn 帮你找到用户任务阶段，第二层 Request 帮你定位 Harness 内部的某一次往返。

## 00:54–01:22　模型为什么会选择 TaskCreate

画面：Request 4 的 Tools。编号 1 先聚焦 `When to Use This Tool`；讲完后渐隐，编号 2 聚焦 Task Fields 和参数说明。

旁白：

远端模型一开始只收到文本和工具定义。Request 4 的 Tools 区显示，Claude Code 向模型声明了 TaskCreate，并说明它适合三个以上步骤的复杂任务，也说明 subject、description 和 activeForm 等字段。模型不是凭空知道如何建任务，它依据的正是这次请求里真实存在的工具说明和参数 schema。

## 01:22–01:42　模型只提出调用，不直接创建任务

画面：点击 Request 4 的 TaskCreate 行。编号 1 短暂聚焦中栏两个调用，随后淡出；编号 2 聚焦右栏两个 `tool_use` 参数。

旁白：

模型的回复包含两个 TaskCreate `tool_use`，分别核对 README 和快速指南。这里还没有任务被真正创建。模型只给出工具名、调用标识和参数；Claude Code 收到回复后，才在本地执行这两个调用。PMA 把模型提出的动作与 Harness 的实际执行边界分开显示。

## 01:42–02:00　结果在下一次用户消息中回传

画面：点击 Request 5 的 TaskCreate 结果。编号 1 标中栏结果与来源编号，随后淡出；编号 2 聚焦右栏两个 `tool_result`。

旁白：

Request 5 才带回两个结果：Task 1 和 Task 2 已创建。中栏的“来源 4”可以直接跳回上一条调用；右栏则显示结果属于 `user` 角色。Claude Code 把本地执行结果封装成后续用户消息，模型因此得到任务编号，才能继续更新状态。

## 02:00–02:30　状态更新之后，才真正读取文件

画面：Request 10 的 History 中段。编号 1 先聚焦两项 `in_progress` 更新；讲完后交叉淡化为编号 2，聚焦 Read 调用和 README 内容。

旁白：

下一轮，模型先把两项任务标成 `in_progress`。Claude Code 回传更新结果后，模型再请求 Read。右栏 History 同时保留了 Read 的绝对路径和返回的 Blue Lantern 文件内容。模型最终能引用项目目标，不是因为它访问了磁盘，而是 Harness 把文件结果放进了后续上下文。

## 02:30–02:55　读取第二份文件，再核对任务状态

画面：History 继续下移。编号 1 聚焦 `docs/guide.md` 和返回内容；随后渐隐，编号 2 聚焦两个 TaskGet 调用。

旁白：

同样的闭环再执行一次：Read 请求快速指南，Claude Code 返回 Turn Rail、Request Rail 和 History 三条原文。随后模型没有直接假设任务状态，而是调用两次 TaskGet，读取最新状态。多步规划不只是列一个清单，还要让后续动作与可验证的任务状态保持一致。

## 02:55–03:14　History 与当前 Message 不是一回事

画面：Request 10 的 History 末段。只保留一圈轻描边，聚焦 TaskGet 的 `in_progress` 结果。

旁白：

打开最终 Request 10 的 History，最末端仍是 TaskGet 返回的 `in_progress`。这是模型发出完成更新之前已经积累的历史。PMA 把它与当前 Message 分开，因此我们能准确回答：最终请求发送前，模型已经知道什么；这一轮刚新增的输入又是什么。

## 03:14–03:36　当前 Message 完成任务状态闭环

画面：切到 Message。编号 1 先聚焦 Assistant 的两个 `TaskUpdate completed`；编号 2 后出现并聚焦两个 `tool_result`。编号 1 保留，因为此处必须同时看到调用和结果的因果关系。

旁白：

切到 Message，上一条 Assistant 回复提出两个 `TaskUpdate`，状态都是 `completed`；紧接着的当前用户输入带回两条更新结果。调用和结果在同一块里一一对应。只有这份新 Message 被送到远端模型之后，模型才具备“任务已经完成”的证据。

## 03:36–04:02　协议视图保留原生角色和顺序

画面：Anthropic Messages 协议交换。编号 1 先聚焦 Read 的 `assistant tool_use` 和 `user tool_result`；讲完后淡出，编号 2 聚焦 TaskGet 与完成更新。

旁白：

如果摘要仍然不够，协议视图保留 Anthropic Messages 的原生路径和顺序。先是 Assistant 的 `tool_use`，再是 User 的 `tool_result`，之后模型才能继续下一步。这里还能连续看到 Read、TaskGet 和 TaskUpdate 的调用标识。开发自有 Harness 时，可以据此检查角色、顺序和关联是否被兼容层改写。

## 04:02–04:20　最终回答必须能回到证据

画面：点击 Request 10 的 Response，轻描边聚焦右栏三条建议。

旁白：

最后的三条建议分别对应两个文件里的真实内容：Turn Rail 定位任务，Request Rail 检查往返，History 核对上下文。PMA 的价值不是让答案看起来更复杂，而是让你能从最终回答一路回到文件结果、任务状态、工具定义和每一次模型请求。

## 04:20–04:34　三步看懂多步任务

画面：结束卡。

旁白：

记住三步：模型根据工具定义提出动作；Claude Code 在本地执行并回传结果；模型使用新的上下文继续下一步。PMA 把一个 Turn 内的所有 Request 连成可检查的证据链，让“Agent 正在规划”不再只是一句黑盒描述。

## 官方事实与本章边界

- Claude Code 当前工具参考列出 `TaskCreate`、`TaskGet`、`TaskList` 和 `TaskUpdate`，并把它们与 `EnterPlanMode`、`ExitPlanMode` 分开：<https://code.claude.com/docs/en/tools-reference>
- `--dangerously-skip-permissions` 属于完全权限模式；本章只在隔离的临时目录、本地假上游和无真实凭证条件下使用：<https://code.claude.com/docs/en/permission-modes>
- 本章不声称远端模型直接执行了任何本地工具，也不把确定性回复描述成真实 Claude 模型能力。
- 本章不展示或推断模型不可见的内部思维链，只展示 Capture 中实际存在的提示词、工具定义、消息、调用、结果和回复。
