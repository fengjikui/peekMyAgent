# peekMyAgent 用户手册

peekMyAgent（PMA）是一个本地优先的 Agent 请求观察工作台。它让你在继续使用 Codex、Claude Code、OpenCode、CodeBuddy、OpenClaw 或自研 Harness 的同时，检查模型实际收到的上下文、工具定义、工具交换、子 Agent、模型参数和原始协议。

PMA 不是用来“破解隐藏提示词”的工具，只用于你自己授权的本地 Agent 会话。

## 第一次使用

从[五分钟快速上手](quick-start.zh-CN.md)开始。它只用一个无需业务背景的目录读取任务，走完安装、启动、观察、停止和清理，并解释工具调用闭环与两级导航。

![PMA 快速上手](../assets/demo/quickstart-tool-loop.gif)

如果更习惯视频，可以先查看[中文核心能力视频的封面、字幕和发布状态](../assets/demo/video/README.md)。约 2 分 24 秒的 v0.1 初剪已经可以本地重建；完成最终旁白和托管验收后再提供公开播放链接，避免把频繁变化的 MP4 放进主仓库。

## 按任务选择章节

| 我现在想做什么 | 阅读 |
| --- | --- |
| 第一次成功捕获并找到一条真实会话 | [观察一次真实 Agent 会话](user-guide/observe-session.md) |
| 分别观察 Codex、Claude Code、OpenCode、CodeBuddy 或 OpenClaw | [观察官方支持的 Harness](user-guide/supported-harnesses.md) |
| 理解 Turn、Request、History、System diff 和上下文构成 | [看懂请求、回复和上下文变化](user-guide/requests-context.md) |
| 从工具声明追到调用、迟到结果和最终回答 | [看懂工具调用、工具结果与迟到回传](user-guide/tools-results.md) |
| 检查 Skill 如何被发现、加载并指导后续工具 | [看懂 Skill 的发现、加载与后续工具调用](user-guide/skills.md) |
| 检查子 Agent 启动、内部请求和结果回流 | [看懂子 Agent 与多 Agent 协作](user-guide/subagents.md) |
| 核对 OpenAI / Anthropic 原生字段或排查 adapter 异常 | [查看原始协议与调试异常](user-guide/protocol-raw.md) |
| 不开发专用 adapter，先观察自研 Harness | [通过通用协议桥接入自研 Harness](user-guide/custom-harness.md) |
| 使用完全权限、暂停、删除数据、导出或卸载 | [完全权限模式、隐私、安全与清理](user-guide/privacy-cleanup.md) |
| 页面为空、没有 response、工具或子 Agent 关联失败 | [常见问题和故障排查](user-guide/troubleshooting.md) |

## 三类用户的推荐路径

### 第一次接触 PMA

1. [五分钟快速上手](quick-start.zh-CN.md)
2. [观察一次真实 Agent 会话](user-guide/observe-session.md)
3. [观察官方支持的 Harness](user-guide/supported-harnesses.md)
4. [看懂工具调用与结果](user-guide/tools-results.md)

先建立“用户请求 → 模型请求 → 工具 → 结果 → 最终回答”的直觉，再接触协议和多 Agent。

### 想研究 Codex、Claude Code 等 Harness

1. [请求、回复和上下文变化](user-guide/requests-context.md)
2. [Skill 的发现、加载与后续工具](user-guide/skills.md)
3. [子 Agent 与多 Agent 协作](user-guide/subagents.md)
4. [原始协议与 Raw](user-guide/protocol-raw.md)

重点区分真实协议字段、PMA 整理语义和有限推断，不能把 roadmap 或单次实验写成 Harness 的稳定实现。

### 正在开发自有 Agent

1. [通用协议桥](user-guide/custom-harness.md)
2. [工具调用与迟到结果](user-guide/tools-results.md)
3. [Skill 的发现与加载](user-guide/skills.md)
4. [原始协议与 Raw](user-guide/protocol-raw.md)
5. [新 Harness 适配工作手册](new-harness-adaptation-playbook.md)

先用通用 OpenAI / Anthropic 桥确认 HTTP 交换，再决定是否需要专用 adapter 解释权限、Skill、压缩或子 Agent。

## Viewer 地图

| 区域 | 解决的问题 |
| --- | --- |
| 左栏 Source 树 | 我正在看哪个 Agent、项目和会话？ |
| 中栏时间线 | 用户请求经过了哪些模型请求、工具与回复？ |
| Turn Rail | 长会话中用户任务进行到哪一轮？ |
| Request Rail | 当前轮内部的多次模型请求分别在哪里？ |
| 请求详情 | 这一次模型实际收到了什么？ |
| 协议视图 | 厂商原生 instructions/messages、工具和回复是什么顺序？ |
| Raw Inspector | 摘要之外的精确字段、headers、provenance 与脱敏记录是什么？ |
| 多 Agent 看板 | 谁启动了子 Agent、子分支做了什么、结果何时回流？ |
| 翻译 | 如何分块阅读长 System、Tools schema 与 Harness 注入？ |
| Context Delta / System diff | 相邻请求复用了什么、新增了什么、固定上下文哪里变化？ |

## 当前能力边界

当前 Viewer 能整理 OpenAI Responses、OpenAI Chat Completions、Anthropic Messages 和 Google GenerateContent 证据。具体捕获完整度取决于 Harness adapter、Capture transport 和实际请求。

PMA 会明确区分：

- 网络代理或文件证据中的事实；
- adapter 基于稳定证据的语义整理；
- 受限推断和 unknown；
- roadmap 中尚未实现的计划。

通用协议桥不会自动证明 Harness 的权限、命令、Skill、压缩、恢复或父子 Agent 语义。

## 安全起点

- 只在自己授权的会话中使用；
- 第一次从虚构、非敏感测试目录开始；
- 完全权限参数只用于外部隔离的受信任环境；
- 不把 Dashboard 或 Capture Proxy 暴露到 loopback 之外；
- 不公开未经逐字段审查的 Raw、截图或 `.peektrace.json.gz`；
- 删除数据前确认目标，`pma clear --all-sessions` 和 `--remove-data` 都是永久操作。

完整说明见[完全权限模式、隐私、安全与清理](user-guide/privacy-cleanup.md)。

## 文档与演示如何保持更新

用户手册中的功能事实必须对应当前仓库、真实 Viewer 和可复现轨迹。每次界面或功能更新后：

1. 运行对应确定性演示脚本；
2. 在 2048×1056 视口、正确 Harness 主题下操作真实 Viewer；
3. 重新检查按钮名称、标签、交互和完整证据；
4. 对原图和 900～1100px README 预览逐帧验收；
5. 同步中文版事实，再更新英文及其他语言；
6. 把产品缺口记录为反馈，不在文档任务中顺手修改主线功能。
7. 运行 `node scripts/documentation-consistency-audit.mjs`，核对章节入口、链接、锚点与核心 CLI 事实；功能分支可再用 `--base <SHA> --json` 生成受影响章节清单。
8. 新增或重命名演示章节时，同步 `assets/demo/storyboard/catalog.zh-CN.json` 中的文档映射与 `review` 合同，确保制作端画面能回到对应中文事实，并能直接打开旁白、字幕、manifest 和两档联系表。

素材来源、箭头草稿、帧时长和验收门禁见[图文与演示素材说明](visual-usage-guide.zh-CN.md)。

功能 Agent 与文档 Agent 的影响矩阵、交接格式和后续主动触发设计见[用户文档与演示素材持续更新机制](documentation-maintenance.md)。
