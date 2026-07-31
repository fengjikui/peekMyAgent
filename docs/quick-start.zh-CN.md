# peekMyAgent 五分钟快速上手

这篇指南只完成一件事：用一个没有项目背景、没有敏感信息的小任务，第一次看清 Agent 如何从用户请求走到工具调用、工具结果和最终回答。

完成后，你会得到这样一条可回溯的执行链：

```text
用户请求
  → 模型决定查看目录
  → list_directory 工具结果回传
  → 模型决定读取 README.md
  → read_file 工具结果回传
  → 模型给出有依据的最终回答
```

![PMA 中的完整工具调用闭环](../assets/demo/quickstart-tool-loop.gif)

这张演示使用真实 PMA Viewer 和确定性假上游生成，不包含真实账号、API Key、用户源码或本地隐私路径。画面采用中文界面、Codex 主题和 1536×792 视口；六个镜头共 42.7 秒，复杂协议画面停留最久。

## 1. 准备一个安全的测试目录

不要从工作中的私有仓库开始。新建一个只包含虚构内容的目录，例如：

```text
hello-agent/
├── README.md
├── data/
│   └── colors.json
└── notes/
    └── idea.md
```

README.md 可以只写：

```markdown
# Hello Agent

## 项目目标

这个最小项目用于演示 Agent 如何查看目录、读取文档，并依据真实工具结果回答问题。
```

这个例子故意简单。用户不需要先理解业务规则，就能把注意力放在 Agent 的工作机制上。

## 2. 安装并打开 PMA

PMA 需要 Node.js 24 或更新版本：

```bash
node --version
npm install --global peekmyagent@next
pma doctor
pma open
```

`pma open` 会启动本地 Viewer，并打开环回地址上的页面。PMA 不应暴露到公网。

## 3. 通过 PMA 启动 Agent

在测试目录中选择你正在使用的 Harness：

```bash
cd <path-to-hello-agent>

pma codex            # Codex CLI
pma claude -c        # Claude Code
pma opencode         # OpenCode
pma codebuddy        # CodeBuddy Code
pma openclaw chat    # OpenClaw
```

不要同时执行全部命令。选一个即可；本指南后续以 Codex CLI 为例。

PMA 不是新的聊天客户端。你仍然在原 Agent 的终端界面里工作，只是该进程的模型请求会同时出现在 Viewer 中。

## 4. 发送第一个观察任务

向 Agent 输入：

```text
请先查看当前文件夹有哪些内容，再读取 README.md 中的「项目目标」部分，最后用一句话说明这个项目是做什么的。
```

理想轨迹包含两次清楚的工具调用：

1. 列出目录，确认 `README.md` 存在；
2. 读取 README 的相关部分，再根据工具返回内容作答。

真实 Agent 可能使用不同工具名称，也可能把读取动作合并为一次调用。这不是错误；PMA 应忠实显示 Harness 实际发送的内容，而不是把它改造成演示脚本预想的样子。

## 5. 在 Viewer 中复盘

### 先看完整执行链

在左侧选择刚刚启动的 Source 和会话。中间区域应能看到用户请求、两次工具调用、两次结果回传和最终回答。

![完整执行链](../assets/demo/quickstart/01-trace.png)

先回答三个问题：Agent 做了哪些动作？动作顺序是什么？最终回答前是否真的读取了文档？

### 看模型实际收到的指令

点击一条请求旁的 `详情`，再选择右侧的 `System` 或 `Developer`。这里展示的是该次模型请求中的实际字段，不是 PMA 根据最终行为猜出的摘要。

![查看 System 指令](../assets/demo/quickstart/02-system.png)

继续查看 `Tools`、`History`、`Message` 和 `Metadata`，可以确认模型、常见请求参数、工具 schema、历史消息与当前用户输入。

### 看工具结果如何进入下一次请求

点击时间线中的工具结果。右侧会显示结果内容及其关联信息；它通常出现在**下一次**模型请求里，而不是产生工具调用的同一请求里。

![工具结果进入后续模型请求](../assets/demo/quickstart/03-tool-result.png)

这个区别很重要：只看终端日志，很容易知道“工具运行过”，却不容易确认 Harness 最终把什么结果、以什么结构重新发给了模型。

### 从结果回到来源调用

点击工具结果旁的 `来源 #N`，Viewer 会跳回产生它的工具调用。再使用返回按钮回到结果，就能在长会话里快速往返，而不必手工翻找。

![从工具结果回到来源调用](../assets/demo/quickstart/04-tool-origin.png)

当工具结果延迟到后面几轮才出现时，这种关联尤其有用。

### 核对最终回答是否有证据

回到最终回答，检查它是否与 README 的真实内容一致，并沿时间线复查它依赖的工具结果。

![核对最终回答](../assets/demo/quickstart/05-final-answer.png)

PMA 不判断答案一定正确；它提供足够的证据，让你判断“模型看到了什么、为什么可能这样回答”。

### 必要时查看原始协议

摘要不够时切换到 `协议视图`，或打开 Raw Inspector。协议视图保持厂商原生顺序；Raw 是最终事实源。

![按原生协议核对完整上下行](../assets/demo/quickstart/06-protocol.png)

在这里可以检查：

- OpenAI Responses / Chat、Anthropic Messages 或 Google GenerateContent 的原生字段；
- System / Developer 指令、input / messages 的精确顺序；
- `model`、推理强度、stream、metadata 等常见参数；
- 工具声明、工具调用 ID、工具结果与模型回复；
- 摘要视图中的条目对应 Raw JSON 的哪个位置。

## 6. 停止与清理

结束被 PMA 启动的 Agent 后，当前 watch 会自动停止，但 Trace 会保留，方便稍后复盘。

```bash
pma shutdown
```

这只停止本地 dashboard 服务，不会删除已捕获会话。确定不再需要任何历史 Trace 时才执行：

```bash
pma clear --all-sessions
```

这是永久清空操作。公开分享截图或 Trace 前，还要检查 System、Tools、Raw、路径、命令输出和历史消息中是否存在隐私信息。

## 7. 下一步看什么

完成这条最小轨迹后，再逐步增加复杂度：

1. [完整用户手册](user-guide.md)：切换 Harness、暂停/恢复 watch、故障排查。
2. 工具调用：比较工具声明、参数、结果和后续模型决策。
3. 子 Agent：观察启动、结果回流和主 Agent 汇总。
4. 协议与 Raw：定位请求字段缺失、顺序异常或兼容层改写。
5. 上下文变化：比较相邻请求增加、删除和复用的内容。
6. [接入自研 Harness](new-harness-adaptation-playbook.md)：先用通用 OpenAI / Anthropic 桥，再按证据开发专用 adapter。

演示镜头、帧时长、素材来源和重生成命令见[图文与演示素材说明](visual-usage-guide.zh-CN.md)。
