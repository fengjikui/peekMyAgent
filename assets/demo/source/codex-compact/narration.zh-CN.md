# 《Codex 上下文压缩究竟改变了什么》中文旁白母稿

本稿是 Codex 机制系列的中文事实母稿。实验使用当前安装的 Codex App Server 0.144.6，通过 PMA 的精确 Capture Proxy 连接确定性本地 OpenAI Responses 假上游。真实的是 App Server 生命周期、上行请求组装和 PMA Viewer；模型回复是固定的公开测试文本，不代表远端模型能力。

- 总时长草案：约 04:10
- 画面：中文 Viewer、Codex 主题、1920×1080 完整三栏
- 任务：记住 Blue Lantern、README.md 和 guide.md 三个公开事实，手动触发一次 compact，再检查下一次请求
- 证据：4 个普通 Turn、5 次模型请求、`contextCompaction` 生命周期、压缩前协议顺序、压缩提示、压缩后 History 和最终回复
- 隐私：隔离的 `CODEX_HOME`、固定 `/tmp` 项目、占位凭证和纯 loopback 上游；原始 Capture 不进入 Git

## 教学合同

观众看完后应该能复述：

> Codex 的上下文压缩不是 PMA 猜出来的一次“历史变短”。当前 PMA 路径中，Codex 先发送一条标记为 `request_kind=compaction` 的 Responses 请求，让模型生成接续摘要；随后保留选中的用户消息，用摘要替换较早的 Assistant 历史，并重新注入当前环境和项目规则。PMA 同时保留压缩前后的精确请求，用户可以逐项核对。

本章只演示手动压缩，不演示接近阈值时的自动压缩。当前 Source 使用 PMA 的自定义 provider，因此展示的是 Codex 的本地摘要压缩路径：请求仍发往 `/v1/responses`。Codex 对内建 OpenAI 或 Azure provider 还可以使用单独的 `/v1/responses/compact` 远端路径；那条路径不在本 Source 中，不能混写成已经录到的事实。

## 00:00–00:15　“已经压缩”没有回答真正的问题

画面：标题卡显示“谁触发、发了什么、下一次怎样重组”三步预告。

旁白：

Codex 提示上下文已经压缩以后，旧消息到底被删除、保留，还是改写成摘要？下一次模型又真正收到了什么？只看一句状态提示，回答不了这些问题。我们直接比较压缩前后的精确请求。

## 00:15–00:42　四个普通 Turn，五次模型请求

画面：完整三栏总览。编号 1 先标出 Turn 3；讲完用户任务阶段后，编号 1 降低权重，编号 2 再标出其中的 Request 4。

旁白：

场景只包含三个公开事实：项目代号是 Blue Lantern，入口文件是 README.md，guide.md 解释观察步骤。前三个 Turn 逐步建立事实；随后 App Server 手动触发 compact；Turn 4 再要求复述。PMA 显示四个普通 Turn，却有五次模型请求。Request 4 留在 Turn 3 内，正好说明两级导航：Turn 找用户任务阶段，Request 找 Harness 内部动作。

## 00:42–01:08　先确认这是 Harness 发起的压缩

画面：先模拟点击 Request 4 的“详情”，再点击 `Metadata`。右栏滚动到请求归因；点击波纹消失后，仅保留一圈轻描边。

旁白：

点击 Request 4 的详情，再打开 Metadata。这里不是根据文本相似度猜测：原始 `x-codex-turn-metadata` 把 `request_kind` 标成 `compaction`。PMA 因此把发起者归为 Harness，把机制归为上下文压缩，并给出高置信度。Capture Proxy 还证明这是一条精确捕获的真实上行请求。

## 01:08–01:38　压缩请求携带了什么

画面：切到 `协议视图`。编号 1 先聚焦上行统计；讲完以后降低权重，编号 2 再聚焦按原始顺序排列的九个 input item。

旁白：

切到协议视图，OpenAI Responses 的原始顺序变得很清楚。压缩请求共有九个 input item：三轮用户消息与 Assistant 回复仍然在场，最后追加一条新的用户形态输入。它不是第四个普通用户任务，而是 Codex 为压缩合成的 checkpoint 提示。先看完整基线，后面才能解释哪些内容真正被替换。

## 01:38–02:04　checkpoint 提示是 Harness 注入

画面：切到 `Harness`。点击波纹退场后，编号 1 与轻描边只聚焦 `harness_compact` 条目。

旁白：

Harness 区把最后一项整理为 `harness_compact`，并保留它在 `messages[8]` 的来源位置。提示要求为下一位模型生成一份简洁交接：当前进度、关键决定、约束、下一步和必要参考。它解释了摘要为什么出现，也明确告诉我们：这段英文不是用户刚才输入的新任务。

## 02:04–02:26　确定性上游返回接续摘要

画面：同一原始帧，上一镜头标注全部淡出，只聚焦中栏 Request 4 的 Assistant 回复。

旁白：

确定性本地上游返回一份公开摘要，保留 Blue Lantern、README.md、guide.md 和压缩后的下一步。真实 Codex 接收这份回复并完成 `contextCompaction` 生命周期。假上游只负责消除随机性和敏感信息；Harness 怎样组装请求、PMA 怎样捕获证据，都来自真实运行。

## 02:26–03:02　下一次 History 被重新组装

画面：Request 5 的 `History`。编号 1 先出现，聚焦保留的三个用户事实；编号 2 后出现，编号 1 淡出，聚焦接续摘要；编号 3 最后出现，编号 2 降低权重，聚焦重新注入的 AGENTS.md 和运行环境。

旁白：

再看 Request 5 的 History。第一步，三个真实用户事实仍然保留。第二步，较早的 Assistant 逐条回复不再重发，改由“另一位模型已经生成摘要”的接续消息承载关键状态。第三步，当前的权限、环境和项目 AGENTS.md 重新注入。压缩没有把会话清空，而是由 Codex 按自己的规则重新组装下一次上下文。

## 03:02–03:24　当前输入仍然单独可查

画面：点击 `Message`，轻描边聚焦右栏当前用户输入；上一镜头的 1、2、3 全部退场。

旁白：

History 说明“以前带了什么”，Message 则单独说明“这一刻新增了什么”。Request 5 的当前输入只是压缩后的检查点问题。把 History 和 Message 分开，能避免把接续摘要、项目规则或 Harness 注入误认成用户刚刚说的话。

## 03:24–03:46　结果证明关键事实仍可继续使用

画面：模拟点击 Request 5 的 Assistant“详情”，右栏打开 Response；点击波纹消失后聚焦完整模型回复。

旁白：

最后打开 Response。确定性上游仍能复述三个事实：Blue Lantern 以 README.md 为入口，guide.md 说明观察步骤。这不是在评价模型记忆力，而是在验证压缩后的真实请求确实携带了足够的接续信息。若结果不对，还可以回到旧 Capture 和 Raw 逐项定位遗漏。

## 03:46–04:10　Codex 与 Claude Code 不能只用一个模板解释

画面：对照卡显示“当前 PMA + Codex”“OpenAI / Azure 远端路径”“Claude Code”三条路径。

旁白：

最后记住差异。当前 PMA 的自定义 provider 让 Codex 走本地摘要压缩：普通 `/responses` 请求加 `request_kind=compaction`，结果是可读摘要。内建 OpenAI 或 Azure provider 可以改走专用 `/responses/compact`，返回形态可能是 opaque compaction item。Claude Code 的 Anthropic Messages 压缩又有自己的 continuation 结构。PMA 的价值不是把它们说成同一种机制，而是让每条真实路径都能被点开核对。

## 官方事实与本章边界

- Codex CLI 官方说明 `/compact` 会把较早对话替换成简洁摘要，Codex 也会自动压缩长会话：<https://learn.chatgpt.com/docs/developer-commands.md?surface=cli>
- Codex App Server 的 `thread/compact/start` 返回 `{}`，随后通过标准 turn/item 通知发送 `contextCompaction` 生命周期：<https://learn.chatgpt.com/docs/app-server.md>
- 当前 Codex 源码按 provider 能力选择本地或远端压缩；只有内建 OpenAI 或识别出的 Azure Responses provider 声明支持远端压缩：<https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs>、<https://github.com/openai/codex/blob/main/codex-rs/model-provider-info/src/lib.rs>
- 当前实验精确验证的是 Codex 0.144.6 + PMA 自定义 provider 的本地摘要路径。它不声称所有 Codex 安装、provider 或未来版本都使用同一个端点和替换结构。
- 本章没有展示自动阈值行为，也没有把 token 下降、缓存数字或“History 变短”单独当作压缩证据。
- 本章不展示或推断模型不可见的思维链，只展示请求、回复、字段顺序、生命周期和上下文组成。
