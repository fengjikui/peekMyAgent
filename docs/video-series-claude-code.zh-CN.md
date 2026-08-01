# 用 PMA 看懂 Claude Code：中文视频系列脚本

本文是五支独立视频的制作母稿。每支视频只回答一个机制问题，使用真实 peekMyAgent Viewer 操作和非敏感确定性上游；不得用后期绘制的假 UI 代替产品画面。

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
- 字幕放在独立底栏，不叠在 Viewer 内容上；每行尽量不超过 20 个汉字，技术名词保留英文；
- 不使用真实 Capture、用户路径、API Key、认证 header、真实源码或私人 System。

## 五支视频的关系

| 编号 | 标题 | 核心问题 | 建议长度 | 当前素材基础 |
| --- | --- | --- | ---: | --- |
| 1 | 一次工具调用到底发生了什么 | 用户、Claude Code、远端模型如何完成一次 Read | 3～4 分钟 | 新建最小 Anthropic 轨迹 |
| 2 | Skill 是怎样被发现和加载的 | 为什么描述先出现、正文到使用时才进入上下文 | 3～4 分钟 | `Skill / Harness 注入` 契约已有 |
| 3 | 子 Agent 在哪里运行，结果怎样回来 | 父级启动、独立上下文、内部工具、结果回流 | 4～5 分钟 | 已有两分支确定性 Source |
| 4 | 上下文压缩究竟改变了什么 | 什么时候压缩、哪些内容被摘要、哪些会重新注入 | 4～5 分钟 | compact 分类已有；正式发布前需补真实 Claude Code 长会话 |
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

### 完整镜头脚本

| 镜头 | 用户动作 | 画面重点 | 旁白要点 | 证明的价值 | 停留 / 标注 |
| --- | --- | --- | --- | --- | --- |
| 1. 三个角色 | 无，标题卡 | 用户 → Claude Code → 远端模型；本地工具挂在 Claude Code 下方 | 模型负责选择和生成，Harness 负责本地执行与权限，用户负责提出目标和批准高风险动作 | 先建立正确心智模型 | 10 秒；只用三节点简图 |
| 2. 输入任务 | 在 Claude Code 终端输入演示请求 | 一行简单用户请求 | 任务故意简单，不需要任何项目背景 | 观众马上理解目标 | 8 秒；框住请求，不露真实路径 |
| 3. 完整时间线 | 切到 PMA，选中 `Claude 工具闭环` Source | 中栏显示用户输入、`Read`、工具结果、最终回答 | 终端只给结果，PMA 把两次模型请求和中间证据放在同一条链上 | 30 秒理解 PMA | 12 秒；标注①完整执行链 |
| 4. 请求参数 | 点击请求 #1 的 `详情`，再点 `Metadata` | model、max_tokens、stream 等顶层字段 | 先确认这一次到底调用了哪个模型，带了哪些常见参数 | 排查模型/参数错配 | 12 秒；箭头终点到 Metadata 标签边缘 |
| 5. System | 点击 `System` | 实际发送的公开 System | 这不是根据最终行为猜的，而是该次请求中的真实字段 | 核对上行上下文 | 12 秒；不框整段正文，只框标题和首两行 |
| 6. 工具目录 | 点击 `Tools`，展开 `Read`，再短暂扫过 `Glob`、`Bash` | 工具名、description、input schema | 模型能选择哪些动作，取决于 Claude Code 在这次请求中给了哪些工具定义 | 解释“为什么选 Read” | 16 秒；标注②可选工具、③Read 参数 |
| 7. 模型提出调用 | 点击时间线的 `Read` 工具调用 | 右栏显示 tool use id、文件路径和行范围 | 模型没有读文件；它只返回“请调用 Read”及参数 | 区分意图与执行 | 14 秒；箭头落在 `tool_use` ID 与参数之间的空白 |
| 8. 本地结果 | 点击下一条工具结果 | `# hello-agent`、已关联调用、`来源 #1` | Claude Code 在本地执行 Read，再把结果交回模型 | 证明真正回传了什么 | 15 秒；框住结果和来源按钮，不遮正文 |
| 9. 追溯来源 | 点击 `来源 #1`，等待跳转，再返回 | 从结果回到原始调用 | 长会话不需要手工搜 ID，PMA 已按同一 tool use id 关联 | PMA 的因果导航价值 | 12 秒；鼠标路径沿右栏空白区 |
| 10. 原生协议 | 点击请求 #2 的 `详情` → `协议视图` | Anthropic `assistant/tool_use` 后接 `user/tool_result` | 在 Anthropic Messages 里，结果通常位于后续 user message 的 content 中 | 教自研 Harness 正确封装 | 18 秒；分别标注 tool_use 与 tool_result，镜头最慢 |
| 11. Raw | 打开 `完整请求` / Raw Inspector，搜索 `read_hello` | 同一 ID 在调用和结果中出现 | 摘要有疑问时回到 Raw；原始 ID 是关联的事实源 | 调试 adapter 与丢字段 | 15 秒；搜索词提前输入，避免无意义键盘过程 |
| 12. 最终回答 | 回到时间线点击最终 Response | “项目名是 hello-agent” | 现在可以判断最终回答是否真的建立在工具结果上 | 闭合证据链 | 10 秒；标注④证据支持的回答 |
| 13. 总结 | 三角色简图重新出现，逐段高亮 | 用户目标 → 结构化请求 → tool use → 本地执行 → tool result → 最终文本 | 模型没有越过 Harness 直接碰电脑；PMA 让每一步都可检查 | 形成可复述结论 | 12 秒 |

视频中不说“Claude Code 一定选择最优工具”。只说“本次 Capture 证明模型从已声明工具中返回了 Read 调用”。

---

## 视频 2：Skill 是怎样被发现和加载的

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
| 2. 请求详情 | 点击请求 #1 `详情` → `Tools` | 只有通用 `Skill` 工具，不是 `project-summary` 专属工具 | Skill 复用通用入口 | 避免混淆 Skill 与 MCP 工具 | 14 秒 |
| 3. 可发现信息 | 点击 `Harness` 或协议中对应的 Skill 列表 | `project-summary` 的名称与 description | 模型先凭简短描述判断是否相关，正文没有提前占满上下文 | 解释按需加载价值 | 15 秒 |
| 4. 调用 | 点击 `Skill` tool use | `{ skill: "project-summary" }` | 这是模型或用户选择 Skill 的证据 | 观察选择依据 | 12 秒 |
| 5. 正文进入 | 点击后续请求的 `Message` / `History`，再切 `协议视图` | `Base directory...` 与 `# Project Summary` 正文 | Skill 正文在使用后进入当前上下文 | 看见加载而非猜测 | 18 秒；复杂镜头慢放 |
| 6. Context Delta | 比较调用前后 Request | 新增 Skill 正文，System 与历史保持可区分 | PMA 能把“新增了什么”与“本来就有的什么”分开 | 调试 Skill 不触发/错触发 | 16 秒 |
| 7. 后续工具 | 点击 Skill 指导下产生的 `Read` | 读取 README 的参数和结果 | Skill 给模型流程知识，真正访问文件仍由工具完成 | 区分知识与能力 | 14 秒 |
| 8. 总结 | 标题卡 | description 用于发现；Skill 工具用于加载；正文指导后续行为 | 三层结论 | 形成记忆点 | 10 秒 |

不要说“所有 Skill 正文永远只加载一次”。压缩、子 Agent 配置和版本会影响生命周期；视频只展示本次请求中的可见证据。

---

## 视频 3：子 Agent 在哪里运行，结果怎样回来

### 演示任务

复用 `/demo/subagent-lab`：主 Agent 同时启动两个只读 Explore 子 Agent；一个读取 `docs/guide.md`，一个核对公开目录；第一个子 Agent 内部再调用一次 `Read`，两个结果最后回到主 Agent。

Claude Code 把 `Agent` 列为一个会启动独立上下文窗口的工具。子 Agent 使用自己的 System、工具权限和消息历史，最后把结果返回主对话。[Claude Code subagents](https://code.claude.com/docs/en/sub-agents) · [Tools reference](https://code.claude.com/docs/en/tools-reference)

### 镜头脚本

| 镜头 | 用户动作 | 画面重点 | 旁白要点 | 证明的价值 | 停留 / 标注 |
| --- | --- | --- | --- | --- | --- |
| 1. 父级请求 | 点击 Turn 开头 | “并行启动两个只读子 Agent” | 一个用户 Turn 可以展开出多个独立分支 | 建立父子关系 | 10 秒 |
| 2. Agent 工具 | 点击两个 `Agent` tool use | description、prompt、subagent_type、两个 ID | 远端模型提出委派，Claude Code 才启动工作单元 | 看清谁启动谁 | 16 秒 |
| 3. 展开看板 | 点击折叠的 multi-agent 看板 | 两个稳定标签、状态和回流信息 | 看板从稳定证据建图，不从自然语言猜分支 | PMA 特色能力 | 15 秒；箭头终点落在展开按钮 |
| 4. 子分支 A | 点击“核对快速开始”标签 | 子 Agent 自己的请求 #2、#3 | 子 Agent 不是一句摘要，它有自己的 System、Tools、History | 深入内部执行 | 16 秒 |
| 5. 子 Agent 工具 | 点击子分支内 `Read` 与结果 | child Read 参数、结果、来源 | 子 Agent 内部仍是完整工具闭环 | 定位分支内错误 | 15 秒 |
| 6. 子分支 B | 切换“核对目录入口” | 独立请求 #4 | 每个分支使用自己的上下文链，不能与主 Agent 混做 diff | 防止错误比较 | 13 秒 |
| 7. 父级回流 | 点击父级启动与回流证据 / 请求 #5 | 两个 tool_result 同时回到主 Agent | 子 Agent 结果只有回到父级上下文后，主 Agent 才能综合使用 | 证明回流 | 18 秒 |
| 8. 最终综合 | 点击主 Agent 最终回答 | 汇总是否与两个分支结果一致 | 检查不是“启动过”，而是“结果被使用” | 完整因果闭环 | 12 秒 |

如果某条真实 Capture 只有 spawn、没有 child request，画面必须保留空态；不得补画不存在的子请求。

---

## 视频 4：上下文压缩究竟改变了什么

### 正式录制前提

这支视频不能只用“History 变短了”来宣称压缩。正式公开版必须补一条当前 Claude Code 真实长会话，至少包含：

1. 压缩前 `/context` 或可核对的上下文规模；
2. `/compact` 或自动 compact 的明确生命周期证据；
3. 压缩请求；
4. 压缩后的下一次真实模型请求；
5. 旧历史被结构化摘要替换、固定 System / 根 CLAUDE.md 等重新注入的可核对证据。

Claude Code 官方说明：接近上下文上限时会先清理旧工具输出，再在需要时总结会话；`/compact [instructions]` 可以手动触发带重点的摘要。项目根 CLAUDE.md、auto memory 和部分已调用 Skill 会按各自规则重新注入。[How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works) · [Context window](https://code.claude.com/docs/en/context-window) · [Sessions](https://code.claude.com/docs/en/sessions)

### 场景设计

- 前 4 个 Turn 依次确认项目名、读取短文档、读取工具输出、形成计划；
- 第 5 个 Turn 再读取一个约 8～12 KB 的公开生成文本，让上下文变化明显但仍易审；
- 运行 `/compact focus on the project goal, files already read, and pending steps`；
- 压缩后追问：“项目名、已经核对的文件、还未完成的步骤分别是什么？”；
- 全程使用临时 `CLAUDE_CONFIG_DIR`、确定性假上游和虚构 `/demo` 路径。

### 镜头脚本

| 镜头 | 用户动作 | 画面重点 | 旁白要点 | 证明的价值 | 停留 / 标注 |
| --- | --- | --- | --- | --- | --- |
| 1. 长会话 | 用 Turn Rail 快速跳过前 5 轮 | Turn 多、Request 更多 | 上下文会随历史、文件和工具结果增长 | 建立压力来源 | 12 秒 |
| 2. 压缩前 | 选压缩前最后 Request → `History` / 请求构成 | 多轮历史和大型工具结果仍在 | 先记录“压缩前是什么”，否则无从比较 | 建立基线 | 16 秒 |
| 3. compact 事件 | 点击 compact 请求 | 时间线标签、特殊摘要指令 | 这是 Harness 发起的机制请求，不是用户新任务 | 区分内部请求 | 16 秒 |
| 4. Raw 证据 | 打开协议 / Raw | compact 提示词的真实位置 | PMA 不因关键词就虚构结果，回到原文确认 | 事实源 | 16 秒 |
| 5. 压缩后 | 选下一次真实用户 Request → `History` | 结构化摘要 + 最近消息 | 压缩不是清空；它用摘要替换较早细节 | 解释核心作用 | 18 秒 |
| 6. System / Skill | 比较压缩前后 `System`、`Harness` | 固定内容与重新注入内容 | 不同加载机制在压缩后的命运不同 | 调试“规则丢失” | 18 秒 |
| 7. 回答复核 | 点击压缩后回答 | 能保留项目名和待办，但旧细节可能不再逐字可见 | 压缩在节省上下文和保留细节之间取舍 | 解释真实影响 | 14 秒 |
| 8. 边界 | 总结卡 | compact 证据、History 替换、重新注入三类证据 | 只凭 token 下降或 History 变短不够 | 防止误判 | 12 秒 |

在尚未取得上述真实前后请求前，只制作“待录镜头脚本”，不发布伪造的压缩 UI 成片。

---

## 视频 5：多步规划不是一段神秘思考

### 演示任务

前 3 个 Turn 是极短对话，用于建立长会话。第 4 个 Turn 输入：

```text
只读检查 README.md 和 docs/guide.md，先建立任务清单，核对两个文件，再给我三步改进计划；不要修改文件。
```

同一 Turn 内生成 5 次模型 Request：

1. `TaskCreate` 建立两个只读核对任务；
2. `Read README.md`；
3. `Read docs/guide.md`；
4. `TaskUpdate` 把核对任务标为完成；
5. 根据两份工具结果返回三步计划。

Claude Code 当前工具参考列出了 TaskCreate / TaskUpdate 等任务工具；Plan permission mode 则是只读探索权限模式，二者不能混称。[Tools reference](https://code.claude.com/docs/en/tools-reference) · [Permission modes](https://code.claude.com/docs/en/permission-modes)

### 镜头脚本

| 镜头 | 用户动作 | 画面重点 | 旁白要点 | 证明的价值 | 停留 / 标注 |
| --- | --- | --- | --- | --- | --- |
| 1. 长会话定位 | 用 Turn Rail 选择第 4 Turn | 全局 Turn Rail | 先找用户任务阶段 | 展示第一级导航 | 12 秒 |
| 2. 当前轮导航 | 点击横向 Request Rail 的 #4～#8 | 同一 Turn 的 5 次 Request | 一个用户请求会触发多次模型往返 | 展示第二级导航 | 15 秒；两个编号分别标全局/局部 |
| 3. 建立任务 | 点击 `TaskCreate` 调用与结果 | 任务内容、ID、状态 | 计划可以外化为 Harness 管理的任务状态 | 观察计划状态 | 14 秒 |
| 4. 查证据 | 依次点击两个 `Read` | 两个文件参数与结果 | 计划不是凭空生成，先收集实际证据 | 证明基于资料 | 每个 12 秒 |
| 5. 更新任务 | 点击 `TaskUpdate` | completed 状态和关联 ID | 多步执行中的状态变化也可追踪 | 定位卡住步骤 | 13 秒 |
| 6. History | 选最终 Request → `History` | 用户目标、任务调用、两个文件结果按顺序存在 | 最终模型能使用什么，取决于 Harness 重新发送了什么 | 看懂规划的上下文 | 18 秒 |
| 7. 最终计划 | 点击 Response | 三步计划与两个文件证据对应 | PMA 让计划的来源和执行过程都可复盘 | 闭环 | 12 秒 |
| 8. Plan mode 边界 | 结尾卡 | “任务工具 ≠ Plan permission mode” | 前者管理步骤，后者约束只读探索和审批 | 避免术语混淆 | 10 秒 |

不要把不可见的内部思维链写进旁白。只讲 Capture 中可见的请求、工具、结果、任务状态和最终计划。

## 素材与证据状态

| 机制 | 可立即使用的仓库证据 | 正式发布前还需什么 |
| --- | --- | --- |
| 工具闭环 | `scripts/claude-mechanisms-media-demo.mjs` 的 2 Request Anthropic Source；已在 2048×1056 Claude 主题实页复核 | 逐帧录制、标注和成片验收 |
| Skill | `scripts/claude-internal-request-turn-smoke.mjs` 的 `Skill / Harness 注入`；Skill tool 语义契约 | 用当前 Claude Code 版本补一条实际 Skill 调用作交叉核对 |
| 子 Agent | `scripts/user-guide-media-demo.mjs` 与现有 Claude 主题多 Agent 素材 | 重新检查当前按钮名称和 2048×1056 布局 |
| 压缩 | `scripts/current-entry-smoke.mjs` 的 compact 分类 | 必须取得真实压缩前后请求，不能只用合成 History 宣传实际机制 |
| 多步规划 | `scripts/claude-mechanisms-media-demo.mjs` 的 4 Turn / 8 Request Source；最后一轮已实页验证 Request Rail | 用当前 Claude Code 版本交叉核对 Task 工具形态，再逐帧录制 |

## 制作顺序

1. 先完成视频 1：它同时验证三角色讲法、Anthropic 工具闭环、Viewer 点击节奏和字幕风格；
2. 用同一视觉模板制作视频 3，复用已经验收的子 Agent Source；
3. 用已经生成的 Skill 和五 Request 规划 Source 完成真实页面交叉核对，再录制对应镜头；
4. 单独做真实 Claude Code compact 实验，证据充分后才制作视频 4；
5. 所有成片先在本地审阅。MP4 不进入主仓库，发布规则见[演示视频的存储与发布策略](media-publishing.zh-CN.md)。

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
