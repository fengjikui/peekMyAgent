# peekMyAgent 图文与演示素材说明

这篇文档记录中文快速上手的演示设计、素材来源和重生成方式。README 当前仍使用 v0.1 GIF；v0.2 已迁移到可逐镜头播放的网页故事板，并生成一版等待所有者审阅的慢速主 GIF 候选稿。它既是用户的图文导览，也是以后界面更新时重录素材的制作说明。

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

## 已发布的 v0.1 GIF 镜头脚本

| 镜头 | 用户动作 | 画面重点 | 要证明的价值 | 标注 | 停留 |
| --- | --- | --- | --- | --- | --- |
| 1. 完整执行链 | 选择演示会话 | 用户请求、两次工具调用、两次结果回传和最终回答 | 一屏先理解 Agent 做了什么 | 先快速扫一遍完整执行链 | 5.2 秒 |
| 2. System | 点击请求右侧的 `详情`，再选择右栏 `System` | `详情` 如何打开证据右栏；模型实际收到的系统指令 | 第一次使用者能把触发按钮与结果区域对应起来 | `2.1` 蓝框指向 `详情`；`2.2` 红框标出 System 内容 | 6.5 秒 |
| 3. 工具结果 | 点击 `list_directory` 的工具结果 | 左侧触发项与右侧实际回传内容 | 不只知道工具运行过，还能确认回传了什么 | `3.1` 蓝框标动作；`3.2` 红框标结果 | 7.5 秒 |
| 4. 来源调用 | 点击 `来源 #1` | Viewer 跳回原始 `function_call` 和参数 | 长会话中也能快速关联调用与迟到结果 | `4.1` 蓝框标来源按钮；`4.2` 红框标原始调用 | 7.5 秒 |
| 5. 最终回答 | 点击最终回复旁的 `详情` | 右栏 Response 与两项工具证据处于同一条链 | 用户可以检查回答是否真的基于文件内容 | `5.1` 蓝框标 `详情`；`5.2` 红框标原始回复 | 6.5 秒 |
| 6. 协议 | 打开一次请求的 `详情`，再点击 `协议视图` | 原生 input 顺序、工具、参数与回复 | 摘要不够时仍可核对完整上下行 | `6.1` 蓝框标 `详情`；`6.2` 蓝框标标签并用红框圈出协议内容 | 9.5 秒 |

总时长 42.7 秒。普通画面已超过 5 秒，复杂协议画面接近 10 秒；没有快速闪切，也没有无意义鼠标移动。

## v0.2 网页故事板

v0.2 不再把大号深色说明卡、固定箭头和字幕直接烘焙进截图。它在同一组真实 Viewer 原图上增加三个可独立替换的层：

1. 说明卡：安装、启动和清理命令；明确是演示说明页，不模拟终端 UI。
2. 渐进标注：轻描边、小编号和点击波纹；每个标注分别声明出现与淡出时刻。
3. 字幕：48 条短句稳定放在底部中央，可以独立翻译或替换配音。

完整故事共 12 个镜头、4 分 11 秒，依次讲安装、受信任目录启动、完整工具闭环、System、工具结果、来源跳转、最终 Response、协议视图、两级导航以及停止和清理。中文旁白与镜头数据分别保存在：

- `assets/demo/source/quickstart/narration.zh-CN.md`
- `assets/demo/source/quickstart/video/timeline.zh-CN.json`
- `assets/demo/video/pma-quickstart.zh-CN.srt`

时间线声明 28 个 `review_points`。每个焦点交接都检查“旧重点、交叉淡化、新重点”；Turn Rail 与 Request Rail 因为需要解释层级关系，保留前一编号后再出现后一编号。

README 候选版从这些已复核状态中选出 17 个镜头，输出为 1024×576、65 帧、74 秒、约 5.6 MiB。普通动作停留 3～5.5 秒，协议顺序停留 7.5 秒，两级导航分别停留 4.5 秒和 6.5 秒。上方 UI 与标注使用 0.6 秒渐变；字幕安全区不参与整帧混合，而是在转场中干净切换，避免相邻两句形成双影。镜头计划和候选文件分别为：

- `assets/demo/source/quickstart/readme-gif.zh-CN.json`
- `assets/demo/quickstart-tool-loop-v0.2-candidate.gif`

候选版尚未替换 README 当前 GIF。它的任务是让所有者先比较节奏、信息密度和标注逻辑，而不是提前形成发布事实。

## 两级导航场景

主 GIF 之外还有一条独立长轨迹，专门回答：

> 当一次会话既有很多 Turn，某个 Turn 内又有很多 Request 时，怎样快速定位？

![Turn / Request 两级导航](../assets/demo/two-level-navigation.gif)

轨迹包含 6 个 Turn、13 个 Request，各轮请求数为 `1、1、3、2、5、1`。前两轮只做简单聊天，第三轮产生三次请求，第五轮连续核对四份公开证据并产生五次请求。镜头先标出右侧全局 Turn Rail，再标出中栏顶部只属于 Turn 5 的 Request Rail，每帧分别停留 6.5 秒和 7.5 秒。

## 画面规范

- 当前视频主视口固定为 1920×1080，逐帧复核另做 1024×576；旧版 2048×1056 原图可以继续作为历史母稿。验收不仅看文件像素，还要看三栏信息密度：右侧详情标签完整显示后仍保留明显空白，正文和顶部控件不因浏览器过窄而挤成一团。
- 网页故事板的正式画面母版使用 `scripts/export-storyboard-video.mjs` 真实播放生成，不从审阅 JPEG 猜测动画。默认导出无网页字幕、无音轨、无字幕轨；带字幕模式只用于检查底部居中、白字细描边和安全区，不得覆盖多语言干净母版。
- Codex 场景使用 Codex 主题；未来 Claude Code 场景使用 Claude 主题。
- 暗夜主题只在主题切换说明中出现，不为每个教程重复录制一套。
- 中文界面优先；英文和其他语言等中文版结构稳定后再翻译。
- v0.1 蓝色表示点击、红色表示结果；v0.2 改用与三种主题都更协调的轻描边、小编号和短点击波纹，不再依赖固定颜色背诵动作语义。
- 1、2、3、4 是讲解节奏，不是静态图例：标注必须随旁白逐个出现，不能在镜头开始时一次叠出全部编号。下一项出现时，上一项只有在仍需对照、回看或建立因果时才继续保留，并通过 `dim_ms` 退为次要；焦点已经转移时，应先渐隐或与下一项交叉淡化。同一帧可以累积多个已经讲过的编号，但每一个新增编号都必须对应一次明确的讲解推进。
- 标签本身已经写明 System、Tools、Metadata、协议视图、完整请求或 Response 时，只用轻描边提示点击目标；不为重复说明再放一个会遮住右栏标题的圆形编号。
- 只有仅靠位置和出现顺序仍无法建立关系时才使用箭头。需要箭头时优先短直线或一次有意义的转折，沿留白连接，不穿过正文；标注不能遮挡按钮、当前标签或关键内容。
- 主 GIF 是基于真实 Viewer 状态的慢速逐帧演示，不伪造产品中不存在的 UI。

## 逐帧视觉验收门禁

每一条箭头在写入生成脚本前，必须先留下一个最小草稿，至少回答四个问题：

1. **从哪里出发**：标注卡片准备放在哪块留白中？
2. **指向哪里**：终点是按钮、标签还是结果区域的哪一条边？箭头不能落在文字中心。
3. **怎样走线**：水平、垂直还是一条浅曲线？控制点要明确，不能完全交给自动布局碰运气。
4. **哪些地方不能经过**：用户消息、模型回复、参数值、当前标签和其他可能需要阅读的证据都属于禁行区。

生成脚本成功退出不等于素材通过验收。每次生成或局部重录后，制作者必须真实打开并审视每一张标注图，而不是只看文件列表或尺寸；至少完成两次检查：

- **完整分辨率检查**：以原始 2048×1056 查看，确认框线、箭头端点、阴影和文字边缘没有偏移或锯齿异常。
- **README 显示宽度检查**：缩放到 GitHub README 中接近 900～1100 像素的实际宽度，确认编号、短文案和目标控件仍然可辨认。

逐帧检查清单：

- 编号在圆形或胶囊徽标中是否水平、垂直居中；`2.1` 等多字符编号是否有足够左右留白；
- 标注文案在整张卡片中是否视觉居中，基线是否一致；
- 蓝色是否只标点击动作，红色是否只标随后查看的结果；
- 箭头终点是否落在控件或结果框的边缘，没有压住按钮文字和关键值；
- 箭头路径是否穿过任何用户可能想阅读的内容；
- 标注卡片是否遮住当前标签、按钮、标题、用户消息或协议字段；
- 画面缩小后是否仍能在一次停留时间内理解“点哪里、看哪里”；
- 在每个标注实际出现和淡出的时间点，画面是否只保留当前理解所需的信息；不能只检查镜头结束时的最终叠加状态；
- 自己是否愿意把这一帧放到产品首页。如果答案不是明确的“是”，就只调整该帧并重新生成、重新检查。

建议在制作记录中为每一帧保留 `通过 / 需调整 / 调整后通过` 状态，以及一句实际发现的问题。界面更新后重录时，必须重新走完这套检查，不能沿用旧结论。

### 当前版本复核记录

2026-07-31 对 v0.1 的 `01`～`07` 完成了 2048×1056 原图与 1024 像素宽 README 预览复核。这条记录只证明当前公开 GIF，不自动证明新版故事板。

2026-08-02 对 v0.2 的 28 个渐进状态分别完成 1920×1080 与 1024×576 复核。第一版最终回复镜头的编号离字幕过近，因此改成短点击波纹；第一次波纹终点又落在按钮下方，按真实画面校正到 `详情` 按钮中心后重新生成两档帧。其余编号居中、焦点边界、字幕安全区和交叉淡化状态均通过。审阅帧与 contact sheet 保存在 `assets/demo/source/quickstart/recording/`。

同日又使用通用网页视频导出器录制快速上手的 12 秒开场、80 秒跨场景段、从第 78 秒开始的 16 秒 System 编号段，以及 3 秒带字幕内部预览。实际 MP4 均为 1920×1080、30 fps、H.264，只有视频流；开场和 Viewer 都没有黑边，场景切换保持浅色淡入，System 镜头实测为“只有 1 → 1/2 交叉 → 只有 2 → 2/3 交叉 → 只有 3”，字幕预览为底部居中白字细描边且没有大黑框。候选视频和抽帧只保存在 Git 忽略的 `tmp/storyboard-video/quickstart/`，不作为仓库发布素材。

末帧门禁修正后，又在干净提交 `ec33fd6282af42ab146b787a4bd31d791e483edb` 完整录制 251 秒快速上手母版：7530 帧、1467 个浏览器重绘帧、H.264 文件约 4.72 MiB，浏览器最终时间为 250953ms，编码最大实时延迟 2.735ms，render manifest 标记 `publishable_picture_master: true`。从成片按时间线 28 个 `review_points` 重新抽帧并逐张查看，全部保持满幅、无黑边、无网页字幕、无控制器；与已审阅 1920×1080 原图比较的平均绝对像素差为 2.27/255，最大为 5.23/255，最大项发生在正常协议交叉淡化帧。该标记只证明画面母版的技术与视觉门禁通过，不代表中文故事已经获得产品所有者发布确认。

同日对 README 候选版的 17 个静态镜头和 9 个代表性转场帧再次进行原尺寸联系表复核。第一次合成发现整帧交叉淡化会把前后字幕叠成双影，因此把底部字幕区改为无混合切换，只保留 UI 与标注的渐变。System、Tool result、Response、协议和两级导航的编号均按讲解顺序出现；没有为自带名称的标签增加重复文字，也没有使用无必要箭头。

## 素材与来源

发布素材：

- `assets/demo/quickstart-tool-loop.gif`：README 首屏主 GIF。
- `assets/demo/quickstart-tool-loop-v0.2-candidate.gif`：74 秒慢速候选版，等待审阅后再决定是否替换首屏素材。
- `assets/demo/quickstart-overview.png`：无标注静态总览。
- `assets/demo/quickstart-overview-annotated.png`：带单一引导标注的静态总览。
- `assets/demo/quickstart/01-trace.png` ～ `06-protocol.png`：工具闭环章节图。
- `assets/demo/two-level-navigation.gif`：Turn / Request 两级导航慢速说明。
- `assets/demo/quickstart/07-two-level-navigation.png`：两级导航静态标注图。

原始素材：

- `assets/demo/source/quickstart/*-raw.png`：真实 Viewer 原始帧。
- `assets/demo/source/quickstart/manifest.json`：源提交、当前事实复核、教学合同、隐私边界、生成物和视觉验收结论。
- `assets/demo/source/quickstart/narration.zh-CN.md`：v0.2 中文旁白母稿。
- `assets/demo/source/quickstart/video/timeline.zh-CN.json`：v0.2 镜头、字幕、标注时机和审阅点。
- `assets/demo/source/quickstart/readme-gif.zh-CN.json`：候选 GIF 的 17 个镜头、停留时长、字幕安全区与体积门禁。
- `assets/demo/source/quickstart/recording/review-1920/`、`review-1024/`：两档逐帧审阅稿。
- `assets/demo/source/navigation/`：6 Turn / 13 Request 长轨迹的原始帧和 manifest。

旧版 `dashboard-overview-tour.gif`、`chat-upstream-context.gif` 和 `tool-call-loop.gif` 暂时保留，供比较与后续迁移；中文版 README 首屏已不再使用它们。

## 重生成演示轨迹

启动确定性假上游和 PMA：

```bash
node scripts/readme-media-demo.mjs --port 43112
```

脚本会打印短轨迹和长轨迹两个 Source URL。用浏览器打开对应 URL，将视口设为 2048×1056，切换中文与 Codex 主题，按镜头脚本操作真实 Viewer。短轨迹的六个状态保存到：

```text
assets/demo/source/quickstart/quickstart-overview-raw.png
assets/demo/source/quickstart/quickstart-system-raw.png
assets/demo/source/quickstart/quickstart-tool-result-raw.png
assets/demo/source/quickstart/quickstart-tool-origin-raw.png
assets/demo/source/quickstart/quickstart-final-raw.png
assets/demo/source/quickstart/quickstart-protocol-raw.png
```

长轨迹选择 Turn 5，确认 Request Rail 显示 `#8 · 1 / 5` 后，将状态保存为：

```text
assets/demo/source/navigation/two-level-navigation-raw.png
```

重新生成标注图和 GIF：

```bash
python3 scripts/build-readme-media.py
```

这条命令只重建当前公开的 v0.1 GIF。v0.2 使用网页故事板：

```bash
python3 -m http.server 43115 --bind 127.0.0.1
node scripts/demo-storyboard-smoke.mjs \
  assets/demo/source/quickstart/video/timeline.zh-CN.json
node scripts/timeline-subtitles-to-srt.mjs \
  assets/demo/source/quickstart/video/timeline.zh-CN.json \
  assets/demo/video/pma-quickstart.zh-CN.srt
```

打开 `assets/demo/storyboard/index.html`，通过 `timeline` 参数载入快速上手时间线；按 `review_points` 在 1920×1080 与 1024×576 两种浏览器视口逐帧复核。只有所有者确认故事后，才用这份时间线重做慢速 GIF 或 MP4。需要发布视频时，可以继续在 ffmpeg、剪映或其他编辑器中添加授权配音，不必重新设计故事。

从已经复核的 1024×576 状态重新构建或只检查 README 候选版：

```bash
python3 scripts/build-readme-storyboard-gif.py
python3 scripts/build-readme-storyboard-gif.py --check
```

构建脚本会拒绝少于 2.5 秒的镜头、重复或缺失的审阅帧、尺寸变化、时长漂移、帧数漂移和超过 8 MiB 的输出。`--check` 不改写 GIF，适合在文档门禁中验证现有候选文件。

## 隐私边界

本次演示只使用：

- 虚构的 `/demo/hello-agent` 路径；
- 虚构文件名和内容；
- 确定性本地假上游；
- 假认证值，且 Viewer 中显示为脱敏值；
- 本地环回地址，不向外部模型或网络服务发送请求。

公开分享新素材前必须逐帧检查 Source 名称、System、Tools、Raw、路径、命令输出和历史消息。不要录制真实 API Key、真实提示词、用户源码、本地隐私路径或不可公开的 Capture。

## 用户手册扩展素材 v0.1

快速上手之后使用 `scripts/user-guide-media-demo.mjs` 生成三条互相独立的确定性 Source：

| 场景 | 用户要理解什么 | 主题 | 发布素材 | 停留时间 |
| --- | --- | --- | --- | --- |
| 上下文演进 | 从第 4 次请求详情进入 `System diff`，区分历史复用、工具结果和固定指令变化 | Codex | `assets/demo/user-guide/context-changes.gif` | 6.5 秒、9.5 秒 |
| 迟到工具结果 | `start_background_scan` 在 #1 发起、到 #4 才回传，仍可点 `来源 #1` | Codex | `assets/demo/user-guide/delayed-tool-result.gif` | 7.5 秒、8.5 秒 |
| 双子 Agent | 主 Agent 启动两个 Explore 分支，展开看板查看 child 请求和结果回流 | Claude | `assets/demo/user-guide/subagent-collaboration.gif` | 6.5 秒、9.5 秒 |

箭头草稿与禁行区：

- 上下文第一帧从右栏空白短曲线回指第 4 次请求的 `详情`，不得压住用户消息；第二帧从次要筛选栏留白指向 `System diff`，红框只覆盖 diff 结果。
- 迟到结果的红箭头落在结果框上边缘，蓝箭头单独落在 `来源 #1` 按钮；两条线不能汇聚到同一语义目标。
- 子 Agent 第一帧从右栏空白水平指向折叠看板；第二帧红框覆盖当前选中分支的完整时间线，不能遮住 Agent 标签、请求正文或回流状态。

2026-08-01 已对上述五张关键标注帧执行 2048×1056 原图和 1024 像素宽预览复核。第一轮发现迟到结果红蓝箭头汇聚，第二轮发现上下文动作卡遮挡用户消息；两处均局部返工并在重新生成后通过。完整 Source、协议、预期语义和脱敏记录见 `assets/demo/source/user-guide/manifest.json`。

同日，“一个用户请求为什么会变成七次模型往返”章节又对 28 个渐进标注状态分别执行了桌面档与 1024×576 复核。2026-08-02 的跨章节生产审计发现，早期桌面目录虽然命名为 `review-1920`，文件字节实际仍是 1280×720；这批文件已经在 `present=1` 的真正 1920×1080 画布重新渲染，并将 28 个稳定时点写入时间线的 `review_points`。Turn / Request、调用 / 结果等需要比较的关系会保留前一编号，但在新编号出现时先用 `dim_ms` 降为次要；工具说明到字段、文件证据到任务状态等独立焦点采用交叉淡出，并在交接后只保留新编号。该章仅用编号与聚焦框即可明确指向，因此没有为了视觉热闹追加箭头。两档审阅帧、联系表与结论记录在 `assets/demo/source/claude-planning/manifest.json`。

2026-08-02，“一次工具调用到底发生了什么”迁移到 v0.2 网页故事板，并对 36 个状态分别执行 1920×1080 与 1024×576 复核。第一轮发现 Metadata、tool_result 和 Response 的聚焦框向右偏到相邻标签或空白；校正后第二轮又发现标签编号遮住右栏标题。最终规则改为“自带名称的标签只用轻描边，编号留给证据”，并用 `dim_ms` 让来源状态在调用参数出现后退为次要。两档联系表、逐帧修正记录和确定性 Source 边界见 `assets/demo/source/claude-tool-loop/manifest.json`。

同日又在干净提交 `4bb27179a4e893cc986e7016a87515a0a0066314` 完整录制该章 245 秒无声画面母版：7350 帧、1805 个浏览器重绘帧、约 4.55 MiB，浏览器最终时间为 244939ms，编码最大实时延迟 52.654ms。整片完整解码和黑帧检查通过；从成片重新抽取 36 个 `review_points` 逐张查看，三栏、点击入口、协议顺序、Raw 和最终 Response 均无遮挡或错位。与已审阅 1920×1080 帧比较的平均绝对像素差为 1.47/255，最大 3.96/255，发生在正常 Raw 交叉淡化帧。MP4、render manifest、抽帧和联系表仍只位于 Git 忽略的 `tmp/storyboard-video/claude-tool-loop/`。

同日，“上下文压缩究竟改变了什么”从每镜头只保存最终状态的九张旧审阅图，迁移为 15 个稳定复核点。两个“详情”镜头分别保存点击波纹和右栏证据状态；Turn / Request 层级、新 History 的两部分、规则输入与结果、时间线分类与 Harness 原文四组关系都让编号 1 先出现，编号 2 出现时再通过 `dim_ms` 把编号 1 降为次要。15 个状态已经分别在真实 1920×1080 与 1024×576 下复核，未使用箭头。联系表和事实边界见 `assets/demo/source/claude-compact/manifest.json`。

随后在干净提交 `28d66330bfa44edb9b5521158af81fc21b109fc1` 完整录制该章 242 秒无声画面母版：7260 帧、1100 个浏览器重绘帧、约 7.27 MiB，浏览器最终时间为 242000ms，编码最大实时延迟 86.622ms。整片完整解码和黑帧检查通过；从成片重新抽取 15 个 `review_points` 逐张查看，两级导航、压缩前基线、独立 compact 请求、History 重建、规则输入与结果均未错位。四组双编号关系都保持“1 先出现，2 后出现，1 再降权”，单一焦点镜头不延续旧标注。与已审阅 1920×1080 帧比较的平均绝对像素差为 5.09/255，最大 7.87/255 出现在无标注的片尾标题卡，复核后确认属于浏览器渲染差异而不是标注位移。MP4、render manifest、抽帧和联系表仍只位于 Git 忽略的 `tmp/storyboard-video/claude-compact/`。

同日又完成了独立的 Codex compact 章节。真实 Codex App Server 轨迹先生成 4 个普通 Turn 和 5 次模型请求，再从 Request 4 的 `request_kind=compaction`、九项 input、Harness checkpoint 提示和 Request 5 重组后的 History 逐层核对。20 个稳定状态分别在 1920×1080 与 1024×576 下审查：入口镜头只冻结一个点击波纹；协议顺序按 1→2 展开；History 按 1→2→3 展开，其中编号 1 在编号 2 出现时降级、在编号 3 出现前退出，编号 2 只作为弱化对照保留。首次取帧误在 700ms 页面淡入期间截图，整批发白，因此全部拒绝；播放器随后增加仅供制作验收的 `review=1` 冻结模式，关闭页面转场和标注动画，但不改变正常播放。重录后编号、框线、点击中心、字幕安全区和双尺寸构图均通过，未使用箭头。联系表和事实边界见 `assets/demo/source/codex-compact/manifest.json`。

为避免后续章节再次依赖一次性浏览器会话，`scripts/capture-storyboard-review-frames.mjs` 已把上述操作收束为 catalog 驱动的命令。使用 Chrome 150 在隔离输出目录重生成 Codex compact 的 40 张帧和两张联系表后，所有文件都通过 JPEG 格式与真实尺寸校验；与当前已提交帧逐像素比较的平均绝对差为 2.40/255，最大单帧为 3.41/255，联系表肉眼一致，因此没有为了更换截图工具而重写现有二进制素材。正式更新时仍须打开联系表和代表性原图自审，自动生成成功不能代替视觉判断。

同日，“Skill 怎样被发现和加载”从 32 张旧式审阅帧迁移为时间线声明的 31 个稳定复核点，并重新生成真实 1920×1080 与 1024×576 两档画面。System、Tools 和协议视图标签已经能够自我解释，只保留轻描边；编号留给 Request 入口、调用、参数、回执、Raw 命中和最终证据。相关的调用与参数允许约半秒共存，焦点已经改变的标记交叉淡出，最终 Response 使用点击波纹后再出现单一证据编号。两档逐帧检查确认编号居中、框线未遮挡正文，并且不需要箭头。联系表和事实边界见 `assets/demo/source/claude-skill/manifest.json`。

随后在干净提交 `86b8ec1ace4f2e52ca4a1f0e902172b144be6561` 完整录制该章 239 秒无声画面母版：7170 帧、1610 个浏览器重绘帧、约 4.88 MiB，浏览器最终时间为 238936ms，编码最大实时延迟 10.293ms。整片完整解码和黑帧检查通过；从成片重新抽取 31 个 `review_points` 逐张查看，完整三栏、编号居中、点击入口、Skill 正文、协议顺序和最终 Response 均未错位。与已审阅 1920×1080 帧比较的平均绝对像素差为 3.48/255，最大 7.05/255 出现在无标注的片尾标题卡，复核后确认属于浏览器渲染差异而不是标注位移。MP4、render manifest、抽帧和联系表仍只位于 Git 忽略的 `tmp/storyboard-video/claude-skill/`。

同日，“子 Agent 在哪里运行，结果怎样回来”从 33 张未声明复核点的旧审阅图迁移为时间线中的 32 个稳定 `review_points`。multi-agent 镜头先用短波纹指示真实展开控件，再让两个分支编号 1、2 依次出现；Turn 2 / Turn 3 对照保留旧编号，但在新阶段出现前通过 `dim_ms` 退为次要；最终 Response 也改为点击波纹后只保留一个证据编号。第一轮自审还发现 Turn 2 降级状态比“显示 Turn 3”的字幕晚约一秒，修正时码后只重渲染相关帧。真实 1920×1080 与 1024×576 两档均通过，未使用箭头。联系表和事实边界见 `assets/demo/source/claude-subagents/manifest.json`。

随后先把旁白母稿中遗留的旧编号方案和一处 Request 编号校正到 v0.3 时间线，再在干净提交 `02720e350dcef1c6320d18ccafd9ef10da2b7a2b` 完整录制 254 秒无声画面母版：7620 帧、1763 个浏览器重绘帧、约 5.75 MiB，浏览器最终时间为 253945ms，编码最大实时延迟 57.69ms。整片完整解码和黑帧检查通过；从成片重新抽取 32 个 `review_points` 逐张查看，完整三栏、multi-agent 点击、两个分支交接、Turn 2 降权、Turn 3 对照和最终 Response 均未错位。与已审阅 1920×1080 帧比较的平均绝对像素差为 4.19/255，最大 7.51/255 出现在无标注的片尾标题卡，复核后确认属于浏览器渲染差异而不是标注位移。MP4、render manifest、抽帧和联系表仍只位于 Git 忽略的 `tmp/storyboard-video/claude-subagents/`。

同日，“自研 Harness 怎样通过通用协议先接入”用真实 `pma observe` 包装两条确定性 Source：OpenAI Responses 与 Anthropic Messages 都是 1 Turn / 2 Request，只完成列目录、回传结果和最终回答。第一轮 Raw 暴露了仓库工作目录，因此整批素材被拒绝并改用固定 `/tmp/pma-custom-harness-demo/public-project` 后重录。25 个稳定状态随后分别在 1920×1080 与 1024×576 下逐张放大检查：编号按旁白逐个出现；OpenAI 上下行对照保留两个同级重点；Anthropic 的 `tool_use` 在 `tool_result` 出现后降权；其余独立焦点交叉淡出。框、编号和字幕已经足以引导视线，所以没有添加箭头。完整镜头脚本、校验值和脱敏边界见 `assets/demo/source/custom-harness/manifest.json`。

同日，“协议视图与 Raw：定位一次 call id 异常”使用真实 Capture Proxy 和确定性 OpenAI Responses 假上游生成 1 Turn / 3 Request：Request 2 回传错误 ID 并收到 HTTP 400，Request 3 修正后成功。第一次采集发现切换 Request 后仍残留上一次 Raw 搜索，且活动 Request 已变成 Request 3，因此拒绝了两张画面，清空搜索并断言右栏标题后局部重录。20 个渐进状态随后分别在真实 1920×1080 与 1024×576 下逐张检查：入口和证据是独立焦点时旧编号退场；正确值与错误值、错误对象与 HTTP 状态、request 与 response fidelity 需要对照时，编号 1 在编号 2 出现后保留但降权。所有编号均视觉居中，字幕保持底部居中，聚焦框未覆盖字段；右栏本身已经提供直接空间关系，因此没有添加箭头。完整镜头脚本、原始帧校验值与事实边界见 `assets/demo/source/protocol-raw/manifest.json`。

同日，“翻译不改原文：读懂长 System 与 Tools”使用真实 Capture Proxy、确定性 OpenAI Responses 模型上游和确定性翻译上游生成 1 Turn / 2 Request。Request 1 带三块 System 和两个 Tools 上行，Request 2 回传目录工具结果并回答。18 个渐进状态分别在 1920×1080 与 1024×576 下逐张检查。第一轮发现编号 1 误框搜索框而不是翻译选择器；第二轮又发现英文原文聚焦框包含下一张 System 卡片，两处都局部修正并重渲染。最终镜头按旁白先出现 1，再出现 2；System 译文与对应原文需要比较时，1 保留但降权；独立入口则交叉淡出。编号居中、字幕保持底部中央、框线没有遮住 schema 标识符，空间关系清楚，因此未添加箭头。完整脚本、双尺寸联系表、校验值和翻译质量边界见 `assets/demo/source/translation/manifest.json`。

## 下一阶段素材优先级

上下文变化、迟到工具结果和 Claude Code 子 Agent 已在用户手册素材 v0.1 中完成。通过用户审阅后，再独立制作：

1. 由所有者审阅当前 Codex / Claude Code 手动压缩对照；通过后再单独研究自动阈值与 OpenAI / Azure 远端 compact 路径，不把未录到的机制写成现状；
2. 为协议与 Raw 排错章、翻译章增加所有者审阅后的正式配音与成片；
3. 使用真人口播或已授权旁白，对中文视频初剪做第二轮 ChatCut / 剪映精修。

每个新主题仍只回答一个核心问题，并先用真实产品证据确认功能存在，不能把 roadmap 写成已实现。

## 中文视频初剪 v0.1

当前已经使用本页通过视觉验收的真实 Viewer 帧，制作约 2 分 24 秒、1920×1080 的中文核心能力视频：

- 成片、旁白、字幕与封面：`assets/demo/video/`；
- 11 张合成帧与中性时间线：`assets/demo/source/video/`；
- 重生成脚本：`scripts/build-demo-video.py`；
- 完整工具调研、镜头脚本和音视频验收：[中文产品演示视频制作说明](video-production.zh-CN.md)。

所有 UI 镜头至少停留 11 秒；复杂协议镜头超过 15 秒。视频字幕位于独立底栏，不遮挡当前按钮、箭头或关键结果。系统配音只是内部审阅占位，公开发布前需确认使用条款或替换为已授权配音。
