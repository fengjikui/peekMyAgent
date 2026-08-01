# 《Skill 怎样被发现和加载》中文旁白母稿

本稿是 Claude Code 机制系列第二章的中文事实母稿。它先用于故事、画面和字幕审阅；正式配音音色另行选择，不在本章内继续试音。

- 总时长草案：约 03:59
- 画面：中文 Viewer、Claude 主题、2048×1056 原始帧
- 任务：显式使用 `project-summary` Skill，总结公开 README
- 证据边界：Claude Code 2.1.220 真实 CLI 通过 PMA Capture Proxy 连接确定性本地假上游；公开画面来自这条真实 Harness 轨迹，假上游不证明模型质量
- 术语：Skill、System、Tools、`tool_use`、`tool_result`、Raw、Harness 保留原写法

## 教学合同

观众看完后应该能复述：

> 简短 description 帮助发现，通用 `Skill` 工具负责请求加载；下一次请求在同一条 user message 中携带加载回执和 Skill 正文，正文再指导 `Read` 完成真实操作。PMA 可以把四层证据放在同一条时间线上核对。

本章不声称模型自主挑选了 `project-summary`，因为演示用户明确指定了它；不声称 Skill 正文永远只加载一次，也不把 Skill 本身说成文件访问能力。

## 00:00–00:15　Skill 到底是什么？

画面：简洁标题卡，依次出现“发现 → 加载 → 执行”。

旁白：

一个 Skill，是不是一个新工具？还是一大段从第一轮开始就占着上下文的提示词？这一支视频，我们只追一条 project-summary Skill，从被看见，到被加载，再到真正指导后续动作。

## 00:15–00:34　先看完整路径

画面：PMA 完整时间线，证据详情栏关闭；机制流程完整显示。

旁白：

任务很简单：使用 project-summary，总结项目名、目标和下一步。Claude Code 实际产生三次模型请求；PMA 又把机制整理成六段：用户请求、加载 Skill、正文回传、调用 Read、结果回传和最终回答。先记住完整路径，再逐段打开证据。

## 00:34–00:56　模型一开始看见什么？

画面：点击请求一的“详情”，再切到 System；聚焦第二条简短 Skill 描述。

旁白：

先看第一次请求的 System。Raw 搜索定位到 `message_system`：可用 Skill 清单只给出 project-summary 的名称和一行 description。模型可以先凭这份描述判断是否相关；完整步骤还没有在这里展开。这次由用户明确指定 Skill，所以我们只验证加载流程，不把它说成模型自主选择。

## 00:56–01:18　每个 Skill 都会新增一个工具吗？

画面：切到 Tools，聚焦通用 `Skill` 和 `Read` 两项。

旁白：

再切到 Tools。当前请求共声明二十八个工具，其中只有一个通用 Skill 入口，也包含后面要用的 Read；并没有一个名叫 project-summary 的专属工具。Claude Code 通过现有入口加载工作流，不会让每个 Skill 都扩张一次工具目录。

## 01:18–01:36　请求加载的证据

画面：点击时间线中的 Skill 调用，右栏显示 `skill_project_summary` 与参数。

旁白：

点击这条 Skill 工具调用。右栏只保留调用标识、工具名和参数 project-summary。到这一步，模型只是用结构化 tool use 请求 Claude Code 加载这份 Skill；详细工作步骤并没有塞进这段参数。

## 01:36–01:53　加载确认不是任务结果

画面：点击 Request 2 的 Skill 工具结果，聚焦 `Launching skill: project-summary` 和“来源 #1”。

旁白：

Request 2 的 tool result 引用同一个调用标识，内容是 Launching skill: project-summary。它只是加载回执，并不是项目总结。PMA 同时保留“来源 #1”，可以直接回到最初那次调用。

## 01:53–02:19　正文什么时候真正进入上下文？

画面：Request 2 的完整请求；Raw 搜索 `Base directory for this skill`，展示 `messages[3].content[1]`。

旁白：

真正的变化也发生在 Request 2。打开完整请求并搜索 Base directory，可以定位到 `messages[3].content[1]`：角色仍是 user，文本包含 Skill 目录、标题和三步正文。它与前一个 tool result 同属一条 user message。PMA 把这次请求标成 Skill、Harness 注入；Raw 则保留了原始位置。

## 02:19–02:41　在 Anthropic Messages 里处于什么位置？

画面：Request 2 的协议视图，依次聚焦 Skill `tool_use`、`tool_result` 和同一条 user message 中的正文文本。

旁白：

协议视图把顺序整理得更清楚：索引四是 assistant 的 Skill tool use；索引五和六都是下一条 user message 的内容块，先是 tool result，再是 Skill 正文文本。PMA 的摘要不会改写这些原生角色、顺序和路径；开发自研 Harness 时，也可以回到这里核对自己的封装。

## 02:41–03:01　Skill 提供知识，不替代工具

画面：点击 Request 2 返回的 Read 调用，右栏显示 `file_path: README.md`。

旁白：

正文要求读取 README，于是模型随后返回独立的 Read 调用，参数指向一次性公开项目中的 README.md。Skill 提供的是一套可复用流程；真正访问本地文件，仍然要经过 Claude Code 的 Read 工具和权限边界。

## 03:01–03:21　文件实际返回了什么？

画面：点击 Request 3 的 Read 工具结果，右栏展示公开 README 内容。

旁白：

下一次请求里的 tool result 返回了公开 README：项目名 Blue Lantern，目标是演示 Agent Skill 的加载与工具闭环，下一步是在 PMA 中比较加载前后的模型请求。这里看到的是工具真正交给模型的内容，不是对结果的二次概括。

## 03:21–03:41　最终回答是否同时遵守两份证据？

画面：点击最终 Response，聚焦三条列表。

旁白：

最后的 Response 正好给出三条：项目名、目标和下一步。现在可以分别核对两件事：三条格式来自 Skill 正文；具体内容来自 Read 的工具结果。回答遵守了流程，也有实际文件证据支撑。

## 03:41–03:59　四层记忆点

画面：结束卡依次点亮 description、Skill、正文、Read，最后出现 PMA 时间线。

旁白：

记住四层：description 用来发现，通用 Skill 工具请求加载，正文指导行为，Read 等工具完成真实操作。PMA 的价值，是让你能在同一条时间线上比较加载前后，并随时回到协议和 Raw，而不是只凭最终表现猜机制。

## 真实 CLI 交叉核对结果

- Claude Code 2.1.220 在隔离配置目录中发现了项目级 `.claude/skills/project-summary/SKILL.md`；
- 一次用户 Turn 产生三次模型请求：Skill 调用、Read 调用、最终回答；
- Request 2 的同一条 user message 依次包含 Skill tool result 与完整正文，不是旧合成轨迹中的两个独立请求；
- README 与 SKILL.md 前后哈希一致；没有真实账号、API Key、第三方请求或用户文件；
- 正式发布只使用 `recording/real-cli/` 下的真实 Viewer 画面，旧合成帧不得继续作为机制证据。
