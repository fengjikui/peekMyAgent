# 《上下文压缩究竟改变了什么》中文旁白母稿

本稿是 Claude Code 机制系列第四章的中文事实母稿。实验使用当前安装的 Claude Code 2.1.220 真实 CLI，通过 PMA 连接确定性本地 Anthropic 假上游。真实的是 Harness 生命周期、上行请求形态和 PMA 解析；模型回复是固定的公开测试文本，不代表真实 Claude 模型能力。

- 总时长草案：约 04:02
- 画面：中文 Viewer、Claude 主题、2048×1056 原始帧
- 任务：记住一个虚构项目的名称、已核对文件和待办，手动执行 `/compact`，再检查下一次请求
- 证据：5 次真实 CLI 请求、PreCompact / SessionStart hook 日志、压缩前后 History、Harness 注入和最终回复
- 隐私：只使用 Blue Lantern 虚构项目、通用临时路径和本地假上游；原始请求不进入 Git

## 教学合同

观众看完后应该能复述：

> `/compact` 不是简单删除几条旧消息。Claude Code 先发出一次独立的压缩请求，让模型生成结构化摘要；下一次模型请求用这份摘要接续较早会话，并重新注入仍适用的项目规则。PMA 既保留压缩前的 Capture，也能展示压缩后真正发送的 History，因此可以直接比较两边。

本章只演示手动 `/compact`，不演示接近上下文上限时的自动压缩。`pma compact` 是整理 PMA 本地存储的维护命令，与 Claude Code `/compact` 无关。

## 00:00–00:15　终端只告诉你“压缩完成”

画面：标题卡。依次出现“压缩请求、重建 History、规则重载”。

旁白：

Claude Code 显示“Compacted”之后，旧对话究竟去了哪里？哪些内容被摘要，哪些规则又会回来？只看终端，很难回答。我们用一条真实 CLI 轨迹，直接比较压缩前后两次模型请求。

## 00:15–00:44　四个 Turn，五次模型请求

画面：完整三栏时间线。编号 1 先标出 Turn 3，讲清外层用户任务；编号 2 后出现，标出同一 Turn 内的 Request 4。编号 1 保留，因为两者需要同时比较层级。

旁白：

场景很简单。前三次对话只记录三件事：项目叫 Blue Lantern，已经核对 README.md 和 docs/guide.md，待办是比较压缩前后请求。然后手动执行带重点说明的 `/compact`，再问一次检查点。PMA 显示四个用户 Turn，却有五次模型请求。压缩请求四仍在 Turn 3 内，这正是两级导航的价值：Turn 定位用户任务阶段，Request 定位 Harness 内部往返。

## 00:44–01:10　先建立压缩前基线

画面：点击 Request 3 用户输入旁的“详情”，右栏打开 History。点击波纹先消失，再用轻描边聚焦右栏。

旁白：

先打开 Request 3 的 History。右栏逐项列出前两个用户输入和模型回复；当前输入则单独位于 Message。这样我们先知道压缩前的请求到底带了什么。没有这条基线，看到后面 History 变短，也不能证明发生了哪一种上下文处理。

## 01:10–01:42　`/compact` 会产生独立模型请求

画面：点击时间线 Request 4 的“详情”，右栏打开 Harness。点击波纹消失后，编号 1 和轻描边聚焦 `harness_compact` 区块，不再增加无必要箭头。

旁白：

执行 `/compact` 后，Claude Code 先触发一次手动 PreCompact 生命周期事件，再发出 Request 4。PMA 把它标成“上下文压缩”，Harness 区还能看到 `harness_compact` 的真实字段路径。这里的长提示词要求只输出结构化摘要，不调用工具，并把我们的重点说明附在末尾。它是 Harness 注入，不是用户刚刚说出的新任务。

## 01:42–02:06　压缩结果是一份接续摘要

画面：同一原始帧，聚焦 Request 4 的模型回复。前一个 Harness 标注已经淡出，画面只保留摘要重点。

旁白：

确定性假上游返回一份公开摘要：项目名、两个已核对文件和待办都被保留。真实 Claude Code 接收这份回复并完成 compact。使用假上游是为了让每次素材都可重建，也避免任何真实提示词或凭证离开本机；它不改变我们要观察的 Harness 请求结构。

## 02:06–02:42　下一次 History 被重新组装

画面：Request 5 的 History。编号 1 先聚焦顶部接续摘要；编号 2 后出现，聚焦下方 `/compact` 命令、执行结果和当前问题。编号 1 保留，用于比较两部分怎样共同组成新请求。

旁白：

再看压缩后的 Request 5。最早两轮不再以逐条用户和模型消息发送，顶部换成一段“从上一段会话继续”的结构化摘要。最近保留的模型回复仍在，随后是本地 `/compact` 命令、压缩完成信息和当前问题。压缩不是把会话清空，而是由 Harness 重新组装下一次请求。若需要逐字旧细节，摘要还明确指向本地完整 transcript；它不会假装摘要等于原文。

## 02:42–03:18　项目规则会重新注入

画面：Request 5 的 Harness。编号 1 先聚焦根 `CLAUDE.md` reminder；编号 2 后出现，聚焦中栏最终回复中的 `ROOT_RULE_RELOADED`。编号 1 保留，因为要展示输入与结果的因果关系。

旁白：

History 不是全部上下文。Request 5 的 Harness 区还显示根 `CLAUDE.md` 被重新注入到 `messages[0].system-reminder[0]`。测试规则要求回答检查点时附加 `ROOT_RULE_RELOADED`，最终回复确实带上了这个标记。这证明规则进入了压缩后的请求并被确定性上游使用。它属于消息中的 Harness reminder，不是 Anthropic 顶层 System 数组。

## 03:18–03:44　什么才算压缩证据

画面：回到 Request 4 的压缩标签与 Harness 证据。两个聚焦区域按顺序出现并共同保留。

旁白：

判断压缩，不能只看 token 下降、缓存数字或 History 变短。这条轨迹同时具备三类证据：明确的 `/compact` 生命周期、独立的压缩请求、以及下一次请求中的摘要替换和规则重载。PMA 观察这些变化，但不会替 Claude Code 触发压缩。`pma compact` 只是另一项本地存储维护命令。

## 03:44–04:02　三步记住上下文压缩

画面：结束卡。依次点亮“压缩请求、重建 History、规则重载”。

旁白：

记住三步：Claude Code 发出压缩请求；结构化摘要接替较早历史；项目规则按加载机制重新进入后续请求。PMA 的价值，是让压缩前的 Capture 和压缩后的真实上行上下文同时可查，而不是只留一句“已经压缩”。

## 官方事实与本章边界

- Claude Code 官方说明会在上下文接近上限时清理旧工具输出，并在需要时生成会话摘要；手动 `/compact [instructions]` 可以指定摘要重点：<https://code.claude.com/docs/en/how-claude-code-works>、<https://code.claude.com/docs/en/context-window>
- compact 后的结构化摘要用于继续会话；根 `CLAUDE.md` 和无路径限制的规则会重新注入：<https://code.claude.com/docs/en/sessions>
- PreCompact hook 能区分 `manual` 与 `auto`，SessionStart 在压缩后使用 `compact` source：<https://code.claude.com/docs/en/hooks>
- 本章没有声称所有细节都能无损保留。需要精确代码、报错原文或早期工具结果时，应回到 PMA 保留的旧请求或本地完整 transcript。
- 本章不把模型不可见的内部思维链当作可观察事实，只展示 Capture 中的提示词、消息、字段、生命周期和回复。
