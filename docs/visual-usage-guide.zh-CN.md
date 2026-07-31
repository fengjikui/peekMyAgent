# peekMyAgent 图文与演示素材说明

这篇文档记录中文快速上手 v0.1 的演示设计、素材来源和重生成方式。它既是用户的图文导览，也是以后界面更新时重录素材的制作说明。

## 这支主 GIF 只回答一个问题

> PMA 如何让我从一条用户请求，一路追踪到工具调用、工具结果、最终回答和原始协议？

![从用户请求追踪到原始协议](../assets/demo/quickstart-tool-loop.gif)

静态首帧：

![PMA 快速上手总览](../assets/demo/quickstart-overview-annotated.png)

主 GIF 不承担安装、子 Agent、上下文压缩、翻译和所有 Harness 差异的讲解。把太多概念塞进一条演示，会迫使第一次使用者先理解项目背景，反而看不清 PMA 的核心价值。这些主题将使用各自独立的短素材逐步补充。

## 演示场景

虚构测试目录：

```text
/demo/hello-agent/
├── README.md
├── data/
│   └── colors.json
└── notes/
    └── idea.md
```

用户请求：

```text
请先查看当前文件夹有哪些内容，再读取 README.md 中的「项目目标」部分，最后用一句话说明这个项目是做什么的。
```

确定性假模型产生三次 OpenAI Responses 请求：

1. 接收 System / Developer 指令、用户请求、模型参数和两项工具定义；调用 `list_directory({"path":"."})`。
2. 接收目录结果；调用 `read_file({"path":"README.md","start_line":1,"end_line":12})`。
3. 接收 README 内容；回答“这个最小项目用于演示 Agent 如何查看目录、读取文档，并依据真实工具结果回答问题。”

这个场景的优势是用户不需要理解任何业务规则。目录、读文件、依据结果回答都是直觉动作，注意力可以完全放在 Harness 如何组织请求，以及 PMA 如何关联证据上。

## 完整镜头脚本

| 镜头 | 用户动作 | 画面重点 | 要证明的价值 | 标注 | 停留 |
| --- | --- | --- | --- | --- | --- |
| 1. 完整执行链 | 选择演示会话 | 用户请求、两次工具调用、两次结果回传和最终回答 | 一屏先理解 Agent 做了什么 | 先看完整执行链 | 5.2 秒 |
| 2. System | 打开请求详情，选择 `System` | 模型实际收到的系统指令 | 摘要背后有可核对的上行上下文 | 查看模型实际收到的系统指令 | 6.5 秒 |
| 3. 工具结果 | 点击 `list_directory` 结果 | 结果内容位于下一次模型请求 | 不只知道工具运行过，还能确认回传了什么 | 工具结果进入下一次模型请求 | 7.5 秒 |
| 4. 来源调用 | 点击 `来源 #1` | 返回原始 `function_call` 和参数 | 长会话中也能快速关联调用与迟到结果 | 一键回到产生结果的工具调用 | 7.5 秒 |
| 5. 最终回答 | 回到最终回复 | 回答与两项工具证据处于同一条链 | 用户可以检查回答是否真的基于文件内容 | 最终回答可以沿证据链复查 | 6.5 秒 |
| 6. 协议 | 切换到 `协议视图` | 原生 input 顺序、工具、参数与回复 | 摘要不够时仍可核对完整上下行 | 按原生协议核对完整上下行 | 9.5 秒 |

总时长 42.7 秒。普通画面已超过 5 秒，复杂协议画面接近 10 秒；没有快速闪切，也没有无意义鼠标移动。

## 画面规范

- 视口固定为 1536×792，接近常见全屏桌面浏览器的信息密度。
- Codex 场景使用 Codex 主题；未来 Claude Code 场景使用 Claude 主题。
- 暗夜主题只在主题切换说明中出现，不为每个教程重复录制一套。
- 中文界面优先；英文和其他语言等中文版结构稳定后再翻译。
- 每帧最多一个红框、一条箭头和一句短标注，不能遮住关键内容。
- 主 GIF 是基于真实 Viewer 状态的慢速逐帧演示，不伪造产品中不存在的 UI。

## 素材与来源

发布素材：

- `assets/demo/quickstart-tool-loop.gif`：README 首屏主 GIF。
- `assets/demo/quickstart-overview.png`：无标注静态总览。
- `assets/demo/quickstart-overview-annotated.png`：带单一引导标注的静态总览。
- `assets/demo/quickstart/01-trace.png` ～ `06-protocol.png`：快速上手章节图。

原始素材：

- `assets/demo/source/quickstart/*-raw.png`：真实 Viewer 原始帧。
- `assets/demo/source/quickstart/manifest.json`：源提交、视口、主题、场景、隐私检查、生成命令和帧时长。

旧版 `dashboard-overview-tour.gif`、`chat-upstream-context.gif` 和 `tool-call-loop.gif` 暂时保留，供比较与后续迁移；中文版 README 首屏已不再使用它们。

## 重生成演示轨迹

启动确定性假上游和 PMA：

```bash
node scripts/readme-media-demo.mjs --port 43112
```

然后用浏览器打开 `http://127.0.0.1:43112`，将视口设为 1536×792，切换中文与 Codex 主题，按镜头脚本操作真实 Viewer。把六个状态保存到：

```text
assets/demo/source/quickstart/quickstart-overview-raw.png
assets/demo/source/quickstart/quickstart-system-raw.png
assets/demo/source/quickstart/quickstart-tool-result-raw.png
assets/demo/source/quickstart/quickstart-tool-origin-raw.png
assets/demo/source/quickstart/quickstart-final-raw.png
assets/demo/source/quickstart/quickstart-protocol-raw.png
```

重新生成标注图和 GIF：

```bash
python3 scripts/build-readme-media.py
```

脚本使用 Pillow 确定性添加红框、箭头、编号和中文字幕，没有新增产品运行依赖。需要发布视频时，可以直接复用这六个原始帧、镜头文案和时长，在 ffmpeg、剪映或其他剪辑工具中生成 MP4、字幕和配音，不必重新设计故事。

## 隐私边界

本次演示只使用：

- 虚构的 `/demo/hello-agent` 路径；
- 虚构文件名和内容；
- 确定性本地假上游；
- 假认证值，且 Viewer 中显示为脱敏值；
- 本地环回地址，不向外部模型或网络服务发送请求。

公开分享新素材前必须逐帧检查 Source 名称、System、Tools、Raw、路径、命令输出和历史消息。不要录制真实 API Key、真实提示词、用户源码、本地隐私路径或不可公开的 Capture。

## 后续素材优先级

在主 GIF 与五分钟快速上手通过用户审阅后，再独立制作：

1. Claude Code 主题下的子 Agent 启动、结果回流与主 Agent 汇总；
2. 上下文变化与压缩前后对比，并明确区分各 Harness 的真实实现；
3. 异步工具结果跨多轮回传和来源定位；
4. System / Tools 分块翻译；
5. 自研 Harness 通过 OpenAI / Anthropic 通用桥接入；
6. 一支可配字幕和旁白的中文视频。

每个新主题仍只回答一个核心问题，并先用真实产品证据确认功能存在，不能把 roadmap 写成已实现。
