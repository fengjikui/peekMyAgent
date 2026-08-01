# 用 PMA 看懂 Claude Code：中文视频系列脚本

本文是五支独立视频的制作母稿。每支视频只回答一个机制问题，使用真实 peekMyAgent Viewer 操作；每章必须明确区分真实 CLI、确定性假上游和纯教学 Source，不得用后期绘制的假 UI 代替产品画面，也不得把合成轨迹说成真实 provider 会话。

## 系列面向谁

| 观众 | 最想解决的问题 | 视频中的切入点 |
| --- | --- | --- |
| 第一次使用 Claude Code 的用户 | “它为什么能读文件、跑命令？模型是不是直接操作了电脑？” | 三个角色与一次最小 Read 工具闭环 |
| 已经在用 Harness 的开发者 | “模型到底收到什么，工具结果怎样回去，长会话为什么难排查？” | Request 详情、协议视图、来源跳转、两级导航 |
| 自研 Agent / Harness 的开发者 | “我应该怎样封装 tool call、result、子 Agent 和上下文变化？” | Anthropic Messages 原生结构、call id、分支与 compact 证据 |

系列不从复杂业务案例开始。所有演示都围绕一个不用背景知识的公开项目：读取 README、查看目录、按一份短指南做计划。观众可以把注意力放在 Agent 机制，而不是先学习“免邮规则”等业务概念。

## 开场必须说清的事实

推荐旁白：

> 为了容易理解，我们常说模型“输入文本、输出文本”。严格来说，Claude 收到的是结构化请求：System、历史消息、工具定义和模型参数；它返回的内容也可能是自然语言，或者一段 `tool_use`。远端模型不会直接读取你的本地文件，也不会自己执行 shell。Claude Code 负责把工具提供给模型、处理权限、在本地执行，再把结果封装进下一次请求。PMA 记录的正是这条往返证据链。

这个表述与 Anthropic 的工具协议一致：模型产生带 `id`、工具名和输入的 `tool_use`；应用执行工具后，把引用同一 ID 的 `tool_result` 放进后续用户消息。[Anthropic tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview)

## 全系列视觉规范

- Viewer 视口固定为 2048×1056；导出画布 1920×1080，保持完整三栏，不裁成紧凑布局；
- 讲 Claude Code 时使用 Claude 主题，讲 Codex 时才使用 Codex 主题；暗色主题只在结尾用 2～3 秒说明可切换；
- 普通 UI 镜头不少于 8 秒；需要读 System、Tools、History、协议或 Raw 的镜头为 12～18 秒；
- 鼠标先停在起点 0.8 秒，再用 0.6～1.0 秒移动到目标，点击后等待布局稳定；
- 编号放在标注圆的几何中心，文字基线经过视觉校正；箭头先确定终点，再沿空白区布线；
- 每个箭头只证明一件事。起点是说明文字，终点落在按钮边缘或目标字段的留白，不压住正文；
- 每个标注画面必须以 2048×1056 原尺寸和约 1024px 文档预览各审一次；不满意就重画该帧；
- 字幕固定在画面底部居中的电影字幕安全区，不使用独立黑框或持续底栏；每条只表达一个语义单位，技术名词保留英文；
- 同一镜头的 1、2、3、4 按旁白顺序逐个出现，不把四项当作静态图例一次铺满；下一项出现时，若仍需比较或建立因果就保留上一项，否则让上一项先渐隐或与下一项交叉淡化；
- 旧标注需要保留时使用 `dim_ms` 降为次要；标签本身已写明 System、Tools、Metadata、协议视图、完整请求或 Response 时只用轻描边，不重复叠加编号；
- 不使用真实 Capture、用户路径、API Key、认证 header、真实源码或私人 System。

## 五支视频的关系

| 编号 | 标题 | 核心问题 | 建议长度 | 当前素材基础 |
| --- | --- | --- | ---: | --- |
| 1 | 一次工具调用到底发生了什么 | 用户、Claude Code、远端模型如何完成一次 Read | 约 4 分钟 | v0.2 网页故事板、51 条字幕和两档各 36 张审阅帧完成；待所有者审阅与真实 CLI 重录决策 |
| 2 | Skill 是怎样被发现和加载的 | 为什么描述先出现、正文到使用时才进入上下文 | 3～4 分钟 | `Skill / Harness 注入` 契约已有 |
| 3 | 子 Agent 在哪里运行，结果怎样回来 | 父级启动、独立上下文、内部工具、异步完成与父级汇总 | 约 4 分 14 秒 | Claude Code 2.1.220 真实 CLI 的 3 Turn / 8 Request Source |
| 4 | 上下文压缩究竟改变了什么 | 什么时候压缩、哪些内容被摘要、哪些会重新注入 | 约 4 分钟 | 当前 Claude Code 真实 CLI 的 5 Request 前后证据、旁白、字幕和原始帧进入 v0.1 |
| 5 | 多步规划不是一段神秘思考 | 一个 Turn 如何展开为任务、工具、结果与最终计划 | 4～5 分钟 | 新建五 Request 长 Turn |

每支视频都能独立观看。视频 1 是 README 首选入口；其余视频从用户手册对应章节进入。

---

## 视频 1：一次工具调用到底发生了什么

### 演示任务

公开目录 `/demo/claude-tool-loop` 只有：

```text
README.md
notes/
```

`README.md` 第一行是 `# hello-agent`。用户输入：

```text
请读取 README.md 第一行，告诉我项目名；不要修改文件。
```

请求里同时声明 `Read`、`Glob` 和 `Bash`，让观众看到模型不是收到一个预定动作，而是从 Harness 提供的工具定义中选择 `Read`。确定性上游返回一次 `Read` tool use；Harness 回传 `# hello-agent`；第二次模型请求给出最终自然语言。

### v0.2 完整镜头脚本

| 镜头 | 用户动作 | 画面重点 | 旁白要点 | 证明的价值 | 停留 / 标注 |
| --- | --- | --- | --- | --- | --- |
| 1. 三个角色 | 标题卡 | 用户提出目标、模型选择动作、Claude Code 本地执行 | 远端模型不会直接读取电脑 | 建立边界 | 17 秒；无编号 |
| 2. 完整闭环 | 选中教学会话 | 一个 Turn、两次请求、调用、结果和回答 | 先记住完整证据链 | 30 秒理解 PMA | 21 秒；一个完整流程编号 |
| 3. 请求参数 | 点击 Request 1 `详情`，切到 Metadata | model、max_tokens、stream、传输路径和上行构成 | 先确认请求没有在中间被改错 | 排查参数错配 | 19 秒；入口编号 → 标签轻描边 → 参数编号 |
| 4. System | 切到 System | 实际发送的公开演示约束 | 捕获证据不同于行为推测 | 核对上行上下文 | 20 秒；标签轻描边 → 正文编号 |
| 5. 工具目录 | 切到 Tools | Read、Glob、Bash 的 description 与 schema | 模型从当前已声明工具中返回 Read | 解释工具可选范围 | 21 秒；标签轻描边 → 工具列表编号 |
| 6. 模型提出调用 | 点击中栏 Read 调用 | `read_hello`、README.md、offset、limit | 模型只提出结构化调用，还没有执行 | 区分意图与执行 | 21 秒；来源编号与参数编号交叉淡出 |
| 7. 本地结果 | 点击 Request 2 工具结果，再看 tool_result | user 角色、同一 ID、`# hello-agent` | Claude Code 执行后把结果放进后续请求 | 证明实际回传内容 | 22 秒；结果编号 → 标签轻描边 → 正文编号 |
| 8. 追溯来源 | 点击 `来源 #1` | 来源状态、返回结果入口、原始调用参数 | PMA 关联结果和最初调用 | 长会话因果导航 | 21 秒；顶部来源状态在正文出现后降为次要 |
| 9. 原生协议 | 切到协议视图 | user、assistant/tool_use、user/tool_result、final assistant | 核对 Anthropic 原生角色和顺序 | 自研 Harness 调试 | 23 秒；标签轻描边 → 上行顺序编号 |
| 10. Raw | 打开完整请求 | 脱敏 headers、body、System、Tools 和 messages | 摘要不足时回到完整证据 | 排查丢字段与改写 | 22 秒；标签轻描边 → 请求树编号 |
| 11. 最终回答 | 点击最终回复详情，再看 Response | “项目名是 hello-agent” | 沿时间线向前核对答案依据 | 闭合证据链 | 22 秒；点击波纹 → 标签轻描边 → 回答编号 |
| 12. 总结 | 标题卡 | tool_use → 本地执行 → tool_result → 最终回答 | 模型选择，Claude Code 执行，PMA 留证 | 形成可复述结论 | 16 秒；无编号 |

视频中不说“Claude Code 一定选择最优工具”。只说“本次 Capture 证明模型从已声明工具中返回了 Read 调用”。

### v0.2 实际产出

- 网页母稿：`assets/demo/storyboard/index.html` 加载工具调用时间线；
- 字幕：`assets/demo/video/pma-claude-tool-loop.zh-CN.srt`，51 条单句字幕；
- 可重建时间线：`assets/demo/source/claude-tool-loop/video/timeline.zh-CN.json`，12 个镜头、36 个稳定审阅点；
- 中文旁白审阅稿：`assets/demo/source/claude-tool-loop/narration.zh-CN.md`；
- Source、真实 Viewer 原始镜头、隐私和 QA 记录：`assets/demo/source/claude-tool-loop/manifest.json`；
- 两档审阅：`recording/review-1920/` 与 `recording/review-1024/`，各 36 张 JPEG 及 contact sheet；
- v0.1 本地 MP4 和 `scripts/build-claude-tool-loop-video.py` 只作为旧母版比较，不渲染当前网页时间线。

v0.2 实际约 4 分 05 秒，协议和 Raw 镜头分别保留 23 秒与 22 秒。当前没有正式配音或发布 MP4。这条两请求 Source 是确定性 Anthropic 教学轨迹，不得写成真实 provider 会话；真实 Claude Code 2.1.220 的同类角色顺序另由 Skill 章节交叉核对，公开前仍需决定是否重录完全相同的真实 CLI 最小任务。

---

## 视频 2：Skill 是怎样被发现和加载的

本章的完整中文旁白、逐句字幕、实际 Viewer 原始帧和网页故事板数据已经进入 v0.3，见 `assets/demo/source/claude-skill/`。事实已经用 Claude Code 2.1.220、PMA Capture Proxy 和确定性本地假上游完成真实 CLI 交叉核对；31 个时间线声明的渐进状态已经分别在真实 1920×1080 与 1024×576 下逐帧复核。动作、切页和证据按旁白逐个揭示：System、Tools、协议视图等自带名称的标签只做轻描边，Skill 调用与参数等相关证据短暂共存后只保留当前重点，最终 Response 先出现点击波纹再出现单一证据编号。公开发布前只剩所有者中文故事审阅与正式配音。

### 演示任务

项目提供公开 Skill `project-summary`。它的 description 是“读取公开 README，并按项目名、目标、下一步三项输出”；正文另含具体步骤。用户输入：

```text
请使用 project-summary skill，总结这个演示项目。
```

Claude Code 官方说明：Skill 名称和 description 会进入可发现列表；较长正文只在使用时加载，用户也可以用 `/skill-name` 直接触发。Skill 通过现有 `Skill` 工具执行，不会为每个 Skill 新增一个工具定义。[Claude Code skills](https://code.claude.com/docs/en/slash-commands) · [Tools reference](https://code.claude.com/docs/en/tools-reference)

### 镜头脚本

| 镜头 | 用户动作 | 画面重点 | 旁白要点 | 证明的价值 | 停留 / 标注 |
| --- | --- | --- | --- | --- | --- |
| 1. 问题 | 标题卡 | “Skill 是工具，还是一大段一直存在的提示词？” | 名称、描述、正文的加载时机不同 | 建立问题 | 8 秒 |
| 2. 请求详情 | 点击请求 #1 `详情` → `Tools` | 28 个工具中只有一个通用 `Skill` 入口，不是 `project-summary` 专属工具 | Skill 复用通用入口 | 避免混淆 Skill 与 MCP 工具 | 14 秒 |
| 3. 可发现信息 | 点击请求 #1 的 `System`，搜索 `project-summary` | `message_system` 中的名称与简短 description | 模型先看到发现信息；本次演示的完整正文不在这里 | 解释分阶段加载 | 22 秒 |
| 4. 调用 | 点击 `Skill` tool use | `{ skill: "project-summary" }` | 这是模型或用户选择 Skill 的证据 | 观察选择依据 | 12 秒 |
| 5. 正文进入 | 点击请求 #2 `详情` → `完整请求`，搜索 `Base directory for this skill` | `messages[3].content[1]` 中的目录、标题与完整步骤 | Skill 正文与加载回执同属一条 user message | 看见加载而非猜测 | 26 秒；本章最慢镜头 |
| 6. 原生顺序 | 切到请求 #2 `协议视图` | 索引 4 的 Skill `tool_use`，以及索引 5、6 的 user `tool_result` 与正文文本 | 摘要之外仍能核对 Anthropic Messages 的角色、顺序与路径 | 自研 Harness 调试 | 22 秒 |
| 7. 后续工具 | 点击 Skill 指导下产生的 `Read` | 读取 README 的参数和结果 | Skill 给模型流程知识，真正访问文件仍由工具完成 | 区分知识与能力 | 14 秒 |
| 8. 总结 | 标题卡 | description 用于发现；Skill 工具用于加载；正文指导后续行为 | 三层结论 | 形成记忆点 | 10 秒 |

不要说“所有 Skill 正文永远只加载一次”。压缩、子 Agent 配置和版本会影响生命周期；视频只展示 Claude Code 2.1.220 这一次请求中的可见证据。本演示由用户明确要求使用 `project-summary`，因此也不声称这是模型自主选择 Skill 的证据。真实 CLI 使用确定性本地假上游，证明的是 Harness 请求组装，不是模型质量。

---

## 视频 3：子 Agent 在哪里运行，结果怎样回来

本章已经取得 Claude Code 2.1.220 的真实 CLI 轨迹，完整中文旁白、52 条逐句字幕、11 张 2048×1056 Viewer 原始帧和网页时间线进入 v0.3，见 `assets/demo/source/claude-subagents/`。Harness 启动、子分支工具生命周期和异步完成通知来自真实 Claude Code；模型回复由本地确定性 Anthropic 假上游固定生成，避免凭证、随机性和真实项目内容。32 个时间线声明的渐进状态已经分别在真实 1920×1080 与 1024×576 下逐帧复核。

### 演示任务

一次性公开项目只含 `README.md`、`docs/guide.md`、`docs/viewer.md` 和一份只读 `CLAUDE.md`。用户明确要求父 Agent 启动两个 Explore 子 Agent：

- “核对快速开始”分支使用 `Read` 读取 `docs/guide.md`；
- “核对公开目录”分支使用 `Bash` 运行只读 `find docs -maxdepth 1 -name '*.md' -type f -print | sort`；
- 父 Agent 不提前猜测，在两次完成通知都返回后给三条中文要点。

运行前后，三份公开文件的 SHA-256 完全一致。`Bash` 的结果明确是 `docs/guide.md` 与 `docs/viewer.md`，没有把工具错误伪装成成功结果。

Claude Code 当前把 `Agent` 列为一个会在独立上下文中运行子 Agent、并把结果返回调用方的工具；旧版本和旧资料中可能仍出现 `Task` 名称。普通子 Agent 与允许成员直接通信的 Agent Team 不同。[Claude Code subagents](https://code.claude.com/docs/en/sub-agents) · [Tools reference](https://code.claude.com/docs/en/tools-reference)

### 当前真实请求顺序

1. Request 1：父级返回两个 `Agent` tool use；
2. Request 2：快速开始分支返回 `Read`；
3. Request 3：目录分支返回只读 `Bash find`；
4. Request 4：父级收到两个“后台启动成功”回执，并明确等待完成通知；
5. Request 5：快速开始分支收到 `Read` 结果并形成小结；
6. Request 6：目录分支收到 `Bash` 结果并形成小结；
7. Request 7：第一个 `task-notification` 到达，父级回复“另一个仍在运行”；
8. Request 8：第二个 `task-notification` 到达，父级使用两个结果形成最终回答。

PMA 把它们组织为三个 Turn：启动阶段、第一次异步完成、第二次异步完成。两个子分支仍分别保留 Request 2 / 5 和 Request 3 / 6 的内部工具闭环。

### v0.3 镜头脚本

| 镜头 | 用户动作 | 画面重点 | 旁白要点 | 证明的价值 | 停留 / 标注 |
| --- | --- | --- | --- | --- | --- |
| 1. 问题 | 标题卡 | “哪个先完成，结果怎样回来？” | 提出父级、分支、异步回流三个问题 | 建立正确问题 | 15 秒 |
| 2. 完整路径 | 查看完整三栏时间线 | 3 Turn、8 Request 和机制流程 | Turn 定位阶段，Request 查看内部往返 | 展示两级导航 | 22 秒；编号 1 后与 2 交叉淡出 |
| 3. 父级委派 | 点击父请求中的 `Agent` 调用 | 两组 description、prompt、Explore | 模型返回结构化委派，Claude Code 运行工作单元 | 看清谁启动谁 | 24 秒；中栏来源淡出后聚焦右栏 |
| 4. 展开分支 | 点击 `multi-agent · 2 个子 Agent` | 两个分支标签和各 2 条请求 | 分支不是最终回答中的黑盒名称 | PMA 分支导航 | 22 秒；展开控件使用点击波纹，两个分支按 1、2 依次出现 |
| 5. Read 调用 | 进入快速开始分支 | Request 2 的工具名和公开临时路径 | 子分支仍有完整工具选择与参数 | 深入分支 | 20 秒；来源与参数交叉淡出 |
| 6. Read 结果 | 点击 Request 5 的工具结果 | `user/tool_result`、公开指南、来源 #2 | 工具结果先进入当前子分支 | 分支内因果追溯 | 20 秒 |
| 7. Bash 闭环 | 切到目录分支 | Request 3 的只读命令、Request 6 的两条路径 | 第二分支有独立工具闭环 | 避免混做 History | 22 秒 |
| 8. 启动确认 | 点击父 Request 4 的 Response | 两个 Agent tool result 与“等待完成通知” | 启动成功不等于任务完成 | 避免最常见误读 | 28 秒；本章最慢镜头 |
| 9. 第一次完成 | 查看 Turn 2 / Request 7 | 系统通知摘要与“另一个仍在运行” | 第一个结果到达后父级继续等待 | 看懂异步错峰 | 24 秒 |
| 10. 第二次完成 | 查看 Turn 2 与 Turn 3 | 两次通知和最终回答的先后 | 三个 Turn 对应三个父级阶段 | 两级导航价值 | 22 秒；编号 1 先出现并降级，再出现 2 作对照 |
| 11. 最终综合 | 点击 Request 8 的 Response | 三条结论分别使用两个分支结果 | 核对结果不仅回来，而且被使用 | 闭合证据链 | 20 秒；点击波纹后只保留一个证据编号 |
| 12. 总结 | 标题卡 | 发起、工具闭环、完成通知、汇总 | 启动确认与完成通知是两件事 | 形成可复述结论 | 15 秒 |

本例由用户明确要求两个子 Agent，因此不声称模型自主决定并行。真实轨迹显示后台启动和错峰完成，但不用于宣称具体性能加速。父 Agent 接收的是子任务结果，不应写成自动获得全部子分支逐字记录。包含任务 ID、Agent ID 和输出文件路径的完整 Message / Raw 不进入公开视频；需要说明原生形态时使用脱敏 `task-notification` 示例。

当前 Viewer 还有一项需要交给功能迭代任务的反馈：“父级启动与回流证据”把 Request 4 的后台启动确认标成结果回流，但真正的完成通知出现在 Request 7 和 8。本章不顺手修改运行时代码，也不把这个标签单独当作完成证据。

### v0.3 实际产出

- 中文旁白：`assets/demo/source/claude-subagents/narration.zh-CN.md`；
- 逐句字幕：`assets/demo/video/pma-claude-subagents.zh-CN.srt`；
- 可重建网页时间线：`assets/demo/source/claude-subagents/video/timeline.zh-CN.json`；
- Source、原始镜头、隐私和 QA 记录：`assets/demo/source/claude-subagents/manifest.json`；
- 真实轨迹生成器：`scripts/claude-subagents-real-cli-probe.mjs`；
- 复用播放器：`assets/demo/storyboard/index.html`；
- 稳定复核点：32 个 `review_points`；
- 两档审阅：`recording/review-1920/` 与 `recording/review-1024/`，各 32 张 JPEG 及 contact sheet。

---

## 视频 4：上下文压缩究竟改变了什么

### 当前真实实验

本章已经取得当前 Claude Code 2.1.220 的真实 CLI 前后请求。实验通过 PMA 连接确定性本地 Anthropic 假上游：Harness 生命周期、协议请求和 Viewer 解析来自真实 CLI；模型回复使用固定公开文本，以避免凭证、随机性和真实项目内容。素材位于 `assets/demo/source/claude-compact/`。

这支视频不能只用“History 变短了”来宣称压缩。当前实验同时包含：

1. Request 3 的压缩前 History 基线；
2. 手动 `/compact` 的 PreCompact 与 SessionStart compact hook 事件；
3. Request 4 的 `harness_compact` 注入提示词与结构化摘要回复；
4. Request 5 的压缩后真实模型请求；
5. 较早逐条历史被接续摘要替换、根 `CLAUDE.md` 作为 Harness reminder 重新注入的可核对证据。

Claude Code 官方说明：接近上下文上限时会先清理旧工具输出，再在需要时总结会话；`/compact [instructions]` 可以手动触发带重点的摘要。项目根 CLAUDE.md、auto memory 和部分已调用 Skill 会按各自规则重新注入。[How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works) · [Context window](https://code.claude.com/docs/en/context-window) · [Sessions](https://code.claude.com/docs/en/sessions)

### 已执行场景

- 前 3 个短 Turn 依次记录项目名、已核对 `README.md`、已核对 `docs/guide.md` 与待办；
- 运行 `/compact focus on the project goal, verified files, and pending checkpoint`；
- 压缩后追问：“项目名、已经核对的文件、还未完成的步骤分别是什么？”；
- 全程使用隔离 `CLAUDE_CONFIG_DIR`、确定性假上游和通用临时路径；原始请求日志被 Git 忽略。

### 镜头脚本

| 镜头 | 用户动作 | 画面重点 | 旁白要点 | 证明的价值 | 停留 / 标注 |
| --- | --- | --- | --- | --- | --- |
| 1. 问题 | 标题卡 | “Compacted 之后旧对话去了哪里？” | 直接比较压缩前后请求 | 建立问题 | 15 秒 |
| 2. 两级导航 | 完整时间线 | 4 Turn、5 Request，压缩 #4 位于 Turn 3 内 | Turn 找用户阶段，Request 找内部往返 | PMA 特色能力 | 29 秒；编号 1 后再出现 2，并共同保留 |
| 3. 压缩前 | Request 3 → `History` | 两组前序用户输入和模型回复 | 先建立前序上下文基线 | 防止误判 | 26 秒 |
| 4. compact 请求 | Request 4 → `Harness` | `harness_compact`、字段路径和重点说明 | 压缩是 Harness 发起的独立模型请求 | 区分内部请求 | 32 秒；本章最慢镜头之一 |
| 5. summary 回复 | Request 4 的 Response | 项目、文件、待办的结构化摘要 | 摘要用于接续，不是最终用户回答 | 解释产物 | 24 秒 |
| 6. 压缩后 | Request 5 → `History` | 接续摘要、最近回复、compact 命令与当前问题 | Harness 重新组装下一次请求 | 核心前后对照 | 36 秒；本章最慢镜头 |
| 7. 规则重载 | Request 5 → `Harness` | 根 `CLAUDE.md` reminder 与最终标记 | 项目规则重新进入请求并被使用 | 调试规则丢失 | 36 秒 |
| 8. 证据边界 | 回到 Request 4 | 生命周期、压缩请求、摘要替换与规则重载 | token 下降或 History 变短本身不够 | 防止误判 | 26 秒 |
| 9. 总结 | 标题卡 | 压缩请求、重建 History、规则重载 | PMA 同时保留压缩前后证据 | 形成记忆点 | 18 秒 |

当前真实 CLI 交叉核对已经完成。九个镜头进一步拆成 15 个稳定 `review_points`：点击详情、第一重点以及需要比较的第二重点分别保存；四个比较镜头在编号 2 出现时使用 `dim_ms` 将编号 1 降为次要，而不是让两个框永久争夺注意力。15 个状态已经分别在真实 1920×1080 与 1024×576 下逐帧复核。正式发布仍要等待产品所有者对中文旁白的确认。不要把确定性假上游的回复描述成真实 Claude 模型能力，也不要把根 `CLAUDE.md` reminder 说成 Anthropic 顶层 System。

---

## 视频 5：多步规划不是一段神秘思考

### 演示任务

前 3 个 Turn 是极短对话，用于建立长会话。第 4 个 Turn 输入：

```text
只读核对 README.md 和 docs/guide.md：先建立任务清单，逐个读取两个文件，更新任务状态，最后给我三条让新用户更容易理解 PMA 的建议。不要修改任何文件。
```

当前 Claude Code 2.1.220 真实 CLI 在同一 Turn 内生成 7 次模型 Request：

1. 两个 `TaskCreate` 建立只读核对任务；
2. 两个 `TaskUpdate` 把任务标为 `in_progress`；
3. `Read README.md`；
4. `Read docs/guide.md`；
5. 两个 `TaskGet` 读取最新任务状态；
6. 两个 `TaskUpdate` 把任务标为 `completed`；
7. 根据两份文件和任务结果返回三条建议。

Claude Code 当前工具参考列出了 TaskCreate / TaskUpdate 等任务工具；Plan permission mode 则是只读探索权限模式，二者不能混称。[Tools reference](https://code.claude.com/docs/en/tools-reference) · [Permission modes](https://code.claude.com/docs/en/permission-modes)

### 镜头脚本

| 镜头 | 用户动作 | 画面重点 | 旁白要点 | 证明的价值 | 停留 / 标注 |
| --- | --- | --- | --- | --- | --- |
| 1. 场景与 Turn | 浏览三个铺垫 Turn 和执行 Turn | 极短公开任务、只读边界 | 业务简单，复杂度只来自 Agent 机制 | 免去项目背景 | 22 秒；编号 1 后出现 2，并共同保留作阶段对照 |
| 2. Request Rail | 选择 Turn 4 | 7 个 Request 刻度和请求链 | 一个用户请求会触发多次模型往返 | 展示第二级导航 | 18 秒；编号 1 后出现 2，并共同保留作上下对应 |
| 3. 工具定义 | 打开 Request 4 → `Tools` | TaskCreate 使用条件和字段 | 模型依据当前请求中的工具说明选择动作 | 看懂“为什么选这个工具” | 28 秒；编号 1 渐隐后出现 2 |
| 4. 建立任务 | 点击 `TaskCreate` 调用 | 两个 tool_use 和参数 | 模型只提出调用，Claude Code 才负责执行 | 区分意图与执行 | 20 秒；中栏编号渐隐后聚焦右栏 |
| 5. 结果回传 | 点击 Request 5 的 TaskCreate 结果 | 来源 #4、user/tool_result、Task ID | 结果在下一次用户消息中进入模型上下文 | 解释 Agent 循环 | 18 秒；中栏编号渐隐后聚焦右栏 |
| 6. 更新并读取 | 在最终 Request 的 History 下移 | in_progress、Read 和 README 结果 | 模型看到的是 Harness 回传的文件证据 | 证明基于资料 | 30 秒；状态焦点与文件焦点交叉淡化 |
| 7. 核对状态 | 继续查看 guide 与 TaskGet | 第二份文件、两个 taskId | 多步执行还要复核任务状态 | 观察计划状态 | 25 秒；文件焦点渐隐后出现 TaskGet |
| 8. History 边界 | 查看 Request 10 → `History` | 末端仍是 TaskGet in_progress | 既有历史与当前新增输入分开 | 看懂上下文切分 | 19 秒；单一聚焦框 |
| 9. Message 闭环 | 切到 `Message` | completed 调用和两条结果 | 最终请求新增的证据是什么 | 看懂当前输入 | 22 秒；编号 1 保留，再出现 2 作因果对照 |
| 10. 原生协议 | 切到 `协议视图` | Read、TaskGet、TaskUpdate 的原生顺序 | assistant/tool_use 后接 user/tool_result | 自研 Harness 调试 | 26 秒；编号 1 渐隐后出现 2 |
| 11. 最终回答 | 点击 Response | 三条建议对应文件原文 | 回答可以一路追溯到任务和文件证据 | 闭环 | 18 秒；点击波纹后单一聚焦框 |
| 12. 边界总结 | 结束卡 | “任务工具 ≠ Plan permission mode” | 前者管理步骤，后者约束只读探索和审批 | 避免术语混淆 | 14 秒 |

不要把不可见的内部思维链写进旁白。只讲 Capture 中可见的请求、工具、结果、任务状态和最终计划。

真实 Source、文件校验值、隐私边界、54 条字幕和完整网页时间线位于 `assets/demo/source/claude-planning/`。28 个渐进标注状态已经写入 `review_points`，并分别在真实 1920×1080 与 1024×576 下逐帧审阅：需要对照的旧编号继续保留，独立焦点切换采用交叉淡出，交接完成后只留下新编号。本章不需要箭头，因为编号位置和聚焦框已经能在不穿过正文的前提下表达关系。第一次跨章节像素审计还发现并修复了早期桌面帧实际为 1280×720 的问题；后续不得用目录名或联系表代替图片字节尺寸验证。原始请求日志继续留在 Git 忽略的 `tmp/claude-planning-real-cli/`，不进入公开仓库。

## 素材与证据状态

| 机制 | 可立即使用的仓库证据 | 正式发布前还需什么 |
| --- | --- | --- |
| 工具闭环 | `scripts/claude-mechanisms-media-demo.mjs` 的 2 Request Anthropic Source；2048×1056 Claude 主题本地 v0.1 已完成逐帧与成片验收 | 所有者内容审阅、正式配音与托管 |
| Skill | `scripts/claude-skill-real-cli-probe.mjs`；Claude Code 2.1.220 的 1 Turn / 3 Request 真实 CLI Capture；10 张 2048×1056 原始帧、31 个稳定 `review_points` 与真实 1920×1080 / 1024×576 双档审阅帧 | 所有者审阅中文故事，再决定是否进入配音与成片 |
| 子 Agent | `scripts/claude-subagents-real-cli-probe.mjs`；Claude Code 2.1.220 的 3 Turn / 8 Request 真实 CLI Capture；11 张原始帧、32 个稳定 `review_points`、真实 1920×1080 / 1024×576 双档审阅帧、旁白、52 条字幕和网页时间线完成 v0.3 | 所有者审阅中文故事，再决定是否进入配音与成片 |
| 压缩 | 当前 Claude Code 2.1.220 真实 CLI 的 5 Request Capture；`assets/demo/source/claude-compact/` 已含旁白、41 条字幕、原始帧、15 个稳定复核点、网页时间线和两档验收联系表 | 所有者确认中文故事；原始请求日志继续保持本地忽略 |
| 多步规划 | 当前 Claude Code 2.1.220 真实 CLI 的 4 Turn / 10 Request Capture；`assets/demo/source/claude-planning/` 已含旁白、54 条字幕、17 张原始 Viewer 帧、13 镜头网页时间线、28 个稳定复核点，以及真实 1920×1080 / 1024×576 两档审阅帧 | 所有者审阅中文故事；原始请求日志继续保持本地忽略 |

## 制作顺序

1. 先完成视频 1：它同时验证三角色讲法、Anthropic 工具闭环、Viewer 点击节奏和字幕风格；
2. 使用已经完成的真实 Claude Code Skill 实验审阅视频 2 的网页渐进标注，不再使用早期把回执与正文拆成两个请求的合成 Source；
3. 用同一网页视觉模板制作视频 3，复用已经验收的子 Agent Source；
4. 使用已经完成的七 Request 真实规划实验审阅视频 5 的网页标注，不再用早期合成 Source 替代；
5. 使用已经完成的真实 Claude Code compact 实验审阅视频 4 的网页标注，不再用合成 History 替代；
6. 所有成片先在本地审阅。MP4 不进入主仓库，发布规则见[演示视频的存储与发布策略](media-publishing.zh-CN.md)。

## 每支视频的最终验收

- 不依赖业务背景也能在 30 秒内复述本支视频的问题；
- 每个机制结论至少有一个可点击的 PMA 证据和一个原生协议 / Raw 兜底；
- 点击前后关系有标注，观众知道右栏为何出现；
- 箭头端点准确、不遮挡文字，编号和字幕视觉居中；
- 关键镜头允许暂停阅读，协议和 Raw 镜头不少于 15 秒；
- 旁白不把推断写成事实，不暴露不可见思维链，不把 roadmap 功能写成当前功能；
- 2048×1056 原图、1024px 预览和 1920×1080 成片中点抽帧均经过人工视觉复核；
- 所有 Source、路径、工具结果、System 与模型回复均可公开且可重建；
- catalog 记录产品 SHA、视频 SHA-256、字幕、封面和最终托管 URL。
