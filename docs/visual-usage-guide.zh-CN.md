# peekMyAgent 图文与演示素材说明

这篇文档记录中文快速上手的演示设计、素材来源和重生成方式。中英文根 README 当前共同引用由 v0.2 网页故事板生成的 74 秒慢速主 GIF；网页母稿、双尺寸审阅帧和正式 GIF 必须同步重建、分别复核。它既是用户的图文导览，也是以后界面更新时重录素材的制作说明。

## 这支主 GIF 只回答一个问题

> PMA 如何让我从一条用户请求，一路追踪到工具调用、工具结果、最终回答和原始协议？

![从用户请求追踪到原始协议](../assets/demo/quickstart-tool-loop.gif)

静态首帧：

![PMA 快速上手总览](../assets/demo/quickstart-overview-annotated.png)

主 GIF 不承担安装、子 Agent、上下文压缩、翻译和所有 Harness 差异的讲解。把太多概念塞进一条演示，会迫使第一次使用者先理解项目背景，反而看不清 PMA 的核心价值。这些主题将使用各自独立的短素材逐步补充。

需要横向比较全部十章时，不再从本文手工复制逐章链接。运行 `node scripts/generate-storyboard-review-index.mjs --require-videos`，再打开 `http://127.0.0.1:43115/tmp/storyboard-video/review-index.html`；统一审片首页会把 HTML 模板、无字幕干净播放、本地 MP4、正式 / 历史素材边界和对应中文章节放在同一页。它只链接 Git 忽略的本地母版，不增加仓库媒体体积。每章的结论与短备注只保存在当前浏览器，并按候选 SHA 隔离；导出 JSON 后先由 `storyboard-review-handoff.mjs` 检查精确候选、章节清单和隐私哨兵，再人工查看备注并决定是否更新 catalog，不能把本地选择直接当成发布事实。

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

README 主 GIF 从这些已复核状态中选出 17 个镜头，输出为 1024×576、65 帧、74 秒、约 4.82 MiB。普通动作停留 3～5.5 秒，协议顺序停留 7.5 秒，两级导航分别停留 4.5 秒和 6.5 秒。上方 UI 与标注使用 0.6 秒渐变；字幕安全区不参与整帧混合，而是在转场中干净切换，避免相邻两句形成双影。镜头计划和输出文件分别为：

- `assets/demo/source/quickstart/readme-gif.zh-CN.json`
- `assets/demo/quickstart-tool-loop.gif`

六帧旧版与 74 秒版本已经通过抽帧联系表并排复核。新版移除了大块黑色说明条、弯曲箭头和旧紧凑布局，现已作为文档分支的 README 首屏素材；合入主线前仍须由所有者在 GitHub 实际渲染中确认节奏和信息密度。

## 两级导航场景

主 GIF 之外还有一条独立长轨迹，专门回答：

> 当一次会话既有很多 Turn，某个 Turn 内又有很多 Request 时，怎样快速定位？

![Turn / Request 两级导航](../assets/demo/two-level-navigation.gif)

轨迹包含 6 个 Turn、13 个 Request，各轮请求数为 `1、1、3、2、5、1`。前两轮只做简单聊天，第三轮产生三次请求，第五轮连续核对四份公开证据并产生五次请求。发布 GIF 直接复用快速上手当前 1024×576 双尺寸复核中的两个状态：先标出右侧全局 Turn Rail，再保留层级关系并标出中栏顶部只属于 Turn 5 的 Request Rail；两帧分别停留 6.5 秒和 7.5 秒。

## 画面规范

- 标题卡与转场统一遵循《演示章节生产流程》的“发布会式视觉基线”：Codex 章节参考 OpenAI 发布会的深石墨、严格左对齐网格和克制留白；Claude Code 章节参考 Anthropic 的暖纸色、舒展排版和较慢停顿。只借鉴信息层级和节奏，不复制品牌资产；真实 Viewer 始终是主证据。
- 发布会风格不是给每一页增加装饰。问题封面、机制判断、真实证据、必要对照与记忆点收束是五种镜头语法；每一屏只推进一个结论，复杂说明拆到下一镜头或用户手册。
- 当前视频主视口固定为 1920×1080，逐帧复核另做 1024×576；旧版 2048×1056 原图可以继续作为历史母稿。验收不仅看文件像素，还要看三栏信息密度：右侧详情标签完整显示后仍保留明显空白，正文和顶部控件不因浏览器过窄而挤成一团。
- 网页故事板的正式画面母版使用 `scripts/export-storyboard-video.mjs` 真实播放生成，不从审阅 JPEG 猜测动画。默认导出无网页字幕、无音轨、无字幕轨；带字幕模式只用于检查底部居中、白字细描边和安全区，不得覆盖多语言干净母版。
- Codex 场景使用 Codex 主题；未来 Claude Code 场景使用 Claude 主题。
- 暗夜主题只在主题切换说明中出现，不为每个教程重复录制一套。
- 中文界面、旁白、字幕和发布文案优先完成；英文和其他语言等中文版结构稳定后再制作。
- 多语言版本不能只翻译 README 正文。标题卡、网页字幕、SRT、旁白稿、画面内补充文字、视频标题和发布帖文案都必须使用目标语言重新生成；命令、协议字段和产品中的原生标识保持原样。无字幕干净母版可以跨语言复用，任何已经烘焙中文字幕的画面都不能作为其他语言的母版。
- v0.1 蓝色表示点击、红色表示结果；v0.2 改用与三种主题都更协调的轻描边、小编号和短点击波纹，不再依赖固定颜色背诵动作语义。
- 1、2、3、4 是讲解节奏，不是静态图例：镜头先停在“只有 1”的状态，让旁白讲完第一个重点，再逐项增加后续编号；相邻编号至少间隔 2.5 秒，复杂信息继续延长。下一项出现时，上一项只有在仍需对照、回看或建立因果时才继续保留，并通过 `dim_ms` 退为次要；焦点已经转移时，应先渐隐或与下一项交叉淡化。同一帧可以累积多个已经讲过的编号，但每一个新增编号都必须对应一次明确的讲解推进。
- 标签本身已经写明 System、Tools、Metadata、协议视图、完整请求或 Response 时，只用轻描边提示点击目标；不为重复说明再放一个会遮住右栏标题的圆形编号。
- 只有仅靠位置和出现顺序仍无法建立关系时才使用箭头。需要箭头时优先短直线或一次有意义的转折，沿留白连接，不穿过正文；标注不能遮挡按钮、当前标签或关键内容。
- 主 GIF 是基于真实 Viewer 状态的慢速逐帧演示，不伪造产品中不存在的 UI。

### 聚焦框的几何规则

聚焦框先记录真实目标边界，再通过 `focus_padding: [horizontal, vertical]` 向外扩展。不能把面板边缘或现有卡片边缘直接当作默认框，也不能通过加粗描边补偿不准确的坐标。

- 普通内容区域在 1920×1080 母版中左右各留约 12～18px，上下各留约 7～10px；单行按钮、标签和窄控件左右留约 8～12px，上下留约 4～7px。
- 一个教学重点包含两个上下相邻区域时，优先使用一个联合框；左右保持正常呼吸空间，上下外缘只留约 6～8px。
- 两个相邻区域需要分别编号比较时，两个框必须对齐左右边界；共享边只留约 3～5px，框间保留约 4～8px，不得互相覆盖，也不能把两行扩成两个松散的大卡片。
- 聚焦框使用约 2px 描边、8～10px 圆角和极轻外圈；全屏画面不能因为视口变宽而长成 3px 以上粗边或过大的圆角。
- 编号优先放在框外的窗格留白中，与框保持可见间隔。编号、框线和阴影都不能压住用户需要阅读的第一个字符。
- 每个框必须在 1920×1080 原尺寸和 1024×576 README 宽度分别审视。如果它看起来像 Viewer 自带的圆角卡片，而不是暂时出现的注意力提示，直接判定为不合格。

README GIF 不会在时间线或 CSS 更新后自动变化。必须先重新生成双尺寸审阅帧，再显式运行 `build-readme-storyboard-gif.py`；否则 HTML 母稿与 GitHub 上的 GIF 会长期不一致。

## 逐帧视觉验收门禁

每一条箭头在写入生成脚本前，必须先留下一个最小草稿，至少回答四个问题：

1. **从哪里出发**：标注卡片准备放在哪块留白中？
2. **指向哪里**：终点是按钮、标签还是结果区域的哪一条边？箭头不能落在文字中心。
3. **怎样走线**：水平、垂直还是一条浅曲线？控制点要明确，不能完全交给自动布局碰运气。
4. **哪些地方不能经过**：用户消息、模型回复、参数值、当前标签和其他可能需要阅读的证据都属于禁行区。

生成脚本成功退出不等于素材通过验收。每次生成或局部重录后，制作者必须真实打开并审视每一张标注图，而不是只看文件列表或尺寸；至少完成两次检查：

- **完整分辨率检查**：当前素材以 1920×1080 查看，确认框线、箭头端点、阴影和文字边缘没有偏移或锯齿异常；旧版 2048×1056 只用于历史素材复核。
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

README 发布素材还要增加一道成片门禁：`readme-gif.zh-CN.json` 实际选中的每一张画面，都必须分别留下 1920×1080、1024×576 和正式 GIF 抽帧三项复核结果。联系表只用于发现全局节奏和明显异常，不能代替逐张打开；`tmp/` 中的候选 HTML、JPEG 或 GIF 也不能代替中英文根 README 共同引用的 `assets/demo/quickstart-tool-loop.gif`。只有正式文件重建后，再从 GIF 的静态停留段和转场中点抽帧复看，才可以记录“README GIF 已通过”。

聚焦框复核必须先回答“这一帧要用户读哪个具体控件或哪组内容”。坐标以真实文字、刻度、按钮或证据内容的外接边界为起点；不能因为目标位于一条横栏中，就把整条横栏和大段空白一起框住。小控件至少在原图上记录近似像素边界，再换算成百分比；生成后同时检查目标是否完整、留白是否均匀、编号是否与框有清楚归属。若框住了空白、切掉文字、跨到相邻控件或让编号看起来指向另一块内容，即使脚本和尺寸检查全部通过也必须返工。

### 当前版本复核记录

2026-07-31 对 v0.1 的 `01`～`07` 完成了 2048×1056 原图与 1024 像素宽 README 预览复核。这条记录只证明当前公开 GIF，不自动证明新版故事板。

2026-08-02 对 v0.2 的 28 个渐进状态分别完成 1920×1080 与 1024×576 复核。第一版最终回复镜头的编号离字幕过近，因此改成短点击波纹；第一次波纹终点又落在按钮下方，按真实画面校正到 `详情` 按钮中心后重新生成两档帧。随后把七张 Source 全部重录为满幅 1920×1080，移除旧宽高比造成的上下留白，并重新校准全部标注：Request 2 的焦点从工具调用行移到实际工具结果行；System、tool_result、Response 和协议视图改为只描边已有名称的标签；右栏证据编号移入分栏留白。两档 28 个状态重新生成并逐帧检查后通过。审阅帧与 contact sheet 保存在 `assets/demo/source/quickstart/recording/`。

同日早先曾使用通用网页视频导出器录制快速上手的 12 秒开场、80 秒跨场景段、从第 78 秒开始的 16 秒 System 标注段，以及 3 秒带字幕内部预览。实际 MP4 均为 1920×1080、30 fps、H.264，只有视频流；开场和 Viewer 都没有黑边，场景切换保持浅色淡入，字幕预览为底部居中白字细描边且没有大黑框。由于本轮又把 Source 与标注校准到满幅 1920×1080，这批本地 MP4 只保留为历史导出验证，不再代表当前候选；所有者确认故事后须从最新时间线重录。视频和抽帧只位于 Git 忽略的 `tmp/storyboard-video/quickstart/`，不作为仓库发布素材。

末帧门禁修正后，又在干净提交 `ec33fd6282af42ab146b787a4bd31d791e483edb` 完整录制 251 秒快速上手母版：7530 帧、1467 个浏览器重绘帧、H.264 文件约 4.72 MiB，浏览器最终时间为 250953ms，编码最大实时延迟 2.735ms，render manifest 标记 `publishable_picture_master: true`。从成片按时间线 28 个 `review_points` 重新抽帧并逐张查看，全部保持满幅、无黑边、无网页字幕、无控制器；与已审阅 1920×1080 原图比较的平均绝对像素差为 2.27/255，最大为 5.23/255，最大项发生在正常协议交叉淡化帧。该标记只证明画面母版的技术与视觉门禁通过，不代表中文故事已经获得产品所有者发布确认。

同日对 README 候选版的 17 个静态镜头和代表性转场帧再次进行原尺寸联系表复核。第一次合成发现整帧交叉淡化会把前后字幕叠成双影，因此把底部字幕区改为无混合切换，只保留 UI 与标注的渐变。满幅 Source 重录后又重建为 65 帧、74 秒、约 4.82 MiB：System、tool_result、Response 和协议视图只描边已有名称，证据编号按讲解顺序出现，两级导航保留 1/2 层级对照；没有重复文字或无必要箭头。

同日对根 README 实际引用的正式 GIF 再次逐帧审计时，推翻了上述“已通过”结论：第一条请求的 `详情`、工具结果的 `来源 #1`、最终回复点击波纹和 Turn Rail 都存在目标坐标偏移，Request 2 工具结果框过松且编号压住框线，Request Rail 更把整段顶部空白误框成导航。修正时先在 1920 原图记录具体文字、结果行和刻度的近似像素边界，再换算为百分比；重新生成 28 个双尺寸状态后逐张打开，最后重建中英文 README 共用的 65 帧正式 GIF，并从成片抽取全部 17 个静态停留段与 16 个转场中点复看。新版正式 GIF 为 1024×576、74 秒、约 4.61 MiB；这一轮也由此增加了“候选不能代替正式 README 文件、联系表不能代替逐张观看”的强制门禁。

## 素材与来源

发布素材：

- `assets/demo/quickstart-tool-loop.gif`：README 首屏 74 秒慢速主 GIF，由双尺寸复核状态重建。
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

旧版 `dashboard-overview-tour`、`chat-upstream-context` 和 `tool-call-loop` 输出在新版主 GIF 通过审阅后已从当前树移除，避免无引用的旧界面继续占用媒体预算；需要比较时仍可从 Git 历史恢复。

## 重生成演示轨迹

需要手工查看确定性假上游和 PMA 时，可运行：

```bash
node scripts/readme-media-demo.mjs --port 43112
```

该命令会打印短轨迹和长轨迹两个 Source URL，适合人工核对。正式素材不依靠手工设置窗口和逐张命名；下面的独立命令会自动启动并清理同一确定性轨迹，在 1920×1080 真实 Viewer 中依次操作详情、System、工具结果、来源、Response、协议视图与 Turn 5，并保存七张无浏览器边框、无标注的原始帧：

```bash
node scripts/capture-readme-source-frames.mjs
```

短轨迹的六个状态保存到：

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

## 用户手册扩展素材 v0.2

快速上手之后使用 `scripts/user-guide-media-demo.mjs` 生成三条互相独立的确定性 Source：

| 场景 | 用户要理解什么 | 主题 | 发布素材 | 停留时间 |
| --- | --- | --- | --- | --- |
| 上下文演进 | 从第 4 次请求详情进入 `System diff`，区分历史复用、工具结果和固定指令变化 | Codex | `assets/demo/user-guide/context-changes.gif` | 6.5 秒、9.5 秒 |
| 迟到工具结果 | `start_background_scan` 在 #1 发起、到 #4 才回传，仍可点 `来源 #1` | Codex | `assets/demo/user-guide/delayed-tool-result.gif` | 7.5 秒、8.5 秒 |
| 双子 Agent | 主 Agent 启动两个 Explore 分支，展开看板查看 child 请求和结果回流 | Claude | `assets/demo/user-guide/subagent-collaboration.gif` | 6.5 秒、3 秒、6.5 秒 |

这三张 GIF 不再使用黑色说明卡或长箭头：

- 上下文和迟到结果保留确定性原始 Viewer 证据，放入不带黑边的 1024×576 中性画布；只使用轻描边和紧邻目标的小编号，不重复按钮文字。
- 子 Agent 直接复用当前 Claude 章节三个 1024×576 审阅状态，让 1 先出现，1/2 短暂共存，最后只保留 2。
- 所有编号由脚本按文字真实边界居中，聚焦框不穿过正文；周围用户手册文字负责解释动作，GIF 内不再堆第二套长说明。

2026-08-02 已用 `scripts/build-user-guide-gifs.py` 重建四张慢速辅助 GIF：两级导航和子 Agent 使用当前章节的 1024×576 审阅帧；上下文与迟到结果在保持旧确定性 Source 全幅信息的同时移除黑卡和弯箭头。四张 GIF 均在 1024×576 原尺寸逐帧查看，完整 Source、输入帧、时长和脱敏记录见 `assets/demo/source/navigation/manifest.json` 与 `assets/demo/source/user-guide/manifest.json`。

同日，“一个用户请求为什么会变成七次模型往返”章节又对 28 个渐进标注状态分别执行了桌面档与 1024×576 复核。2026-08-02 的跨章节生产审计发现，早期桌面目录虽然命名为 `review-1920`，文件字节实际仍是 1280×720；这批文件已经在 `present=1` 的真正 1920×1080 画布重新渲染，并将 28 个稳定时点写入时间线的 `review_points`。Turn / Request、调用 / 结果等需要比较的关系会保留前一编号，但在新编号出现时先用 `dim_ms` 降为次要；工具说明到字段、文件证据到任务状态等独立焦点采用交叉淡出，并在交接后只保留新编号。该章仅用编号与聚焦框即可明确指向，因此没有为了视觉热闹追加箭头。两档审阅帧、联系表与结论记录在 `assets/demo/source/claude-planning/manifest.json`。

随后在干净提交 `d6b8e8720955354984822cf9b8f9d67d1cb6b66e` 完整录制该章 274 秒无声画面母版：8220 帧、1927 个浏览器重绘帧、约 7.19 MiB，浏览器最终时间为 273944ms，编码最大实时延迟 53.032ms。整片完整解码和黑帧检查通过；从成片重新抽取 28 个 `review_points` 逐张查看，Turn / Request 两级导航、任务状态、文件结果、History / Message 边界、协议顺序和最终 Response 均未错位。需要比较的旧编号先降权再保留，独立焦点在交接后只留下新编号。与已审阅 1920×1080 帧比较的平均绝对像素差为 4.65/255，最大 7.50/255 出现在无标注的片头标题卡，复核后确认属于浏览器与编码渲染差异。MP4、render manifest、抽帧和联系表仍只位于 Git 忽略的 `tmp/storyboard-video/claude-planning/`。

2026-08-02，“一次工具调用到底发生了什么”迁移到 v0.2 网页故事板，并对 36 个状态分别执行 1920×1080 与 1024×576 复核。第一轮发现 Metadata、tool_result 和 Response 的聚焦框向右偏到相邻标签或空白；校正后第二轮又发现标签编号遮住右栏标题。最终规则改为“自带名称的标签只用轻描边，编号留给证据”，并用 `dim_ms` 让来源状态在调用参数出现后退为次要。两档联系表、逐帧修正记录和确定性 Source 边界见 `assets/demo/source/claude-tool-loop/manifest.json`。

同日又在干净提交 `4bb27179a4e893cc986e7016a87515a0a0066314` 完整录制该章 245 秒无声画面母版：7350 帧、1805 个浏览器重绘帧、约 4.55 MiB，浏览器最终时间为 244939ms，编码最大实时延迟 52.654ms。整片完整解码和黑帧检查通过；从成片重新抽取 36 个 `review_points` 逐张查看，三栏、点击入口、协议顺序、Raw 和最终 Response 均无遮挡或错位。与已审阅 1920×1080 帧比较的平均绝对像素差为 1.47/255，最大 3.96/255，发生在正常 Raw 交叉淡化帧。MP4、render manifest、抽帧和联系表仍只位于 Git 忽略的 `tmp/storyboard-video/claude-tool-loop/`。

同日按发布会式视觉基线重做 v0.3 Source：`scripts/capture-claude-tool-loop-source-frames.mjs` 会启动确定性 Anthropic 教学轨迹，实际操作 PMA Viewer，显式切换到 Claude 主题，并断言十张 Source 都是无浏览器外壳、无黑边的 1920×1080 PNG。新 Source 替换旧 2048×1056 画面后，36 个时点又在 1920×1080 与 1024×576 下完整重生成。原尺寸审片发现旧坐标让右栏大框穿过 `请求身份`、`system`、`Read` 等正文，编号也压住内容；框线随后移到证据边距，编号改放在框外或中栏空白，重新生成后逐张复核通过。审阅 JPEG 采用质量 84，1024 档的模型名、参数、Raw 脱敏字段和字幕仍可辨认。旧 v0.2 母版不再代表当前 Source，必须在所有者确认故事后重新导出。

同日，“上下文压缩究竟改变了什么”从每镜头只保存最终状态的九张旧审阅图，迁移为 15 个稳定复核点。两个“详情”镜头分别保存点击波纹和右栏证据状态；Turn / Request 层级、新 History 的两部分、规则输入与结果、时间线分类与 Harness 原文四组关系都让编号 1 先出现，编号 2 出现时再通过 `dim_ms` 把编号 1 降为次要。15 个状态已经分别在真实 1920×1080 与 1024×576 下复核，未使用箭头。联系表和事实边界见 `assets/demo/source/claude-compact/manifest.json`。

随后在干净提交 `28d66330bfa44edb9b5521158af81fc21b109fc1` 完整录制该章 242 秒无声画面母版：7260 帧、1100 个浏览器重绘帧、约 7.27 MiB，浏览器最终时间为 242000ms，编码最大实时延迟 86.622ms。整片完整解码和黑帧检查通过；从成片重新抽取 15 个 `review_points` 逐张查看，两级导航、压缩前基线、独立 compact 请求、History 重建、规则输入与结果均未错位。四组双编号关系都保持“1 先出现，2 后出现，1 再降权”，单一焦点镜头不延续旧标注。与已审阅 1920×1080 帧比较的平均绝对像素差为 5.09/255，最大 7.87/255 出现在无标注的片尾标题卡，复核后确认属于浏览器渲染差异而不是标注位移。MP4、render manifest、抽帧和联系表仍只位于 Git 忽略的 `tmp/storyboard-video/claude-compact/`。

同日又完成了独立的 Codex compact 章节。真实 Codex App Server 轨迹先生成 4 个普通 Turn 和 5 次模型请求，再从 Request 4 的 `request_kind=compaction`、九项 input、Harness checkpoint 提示和 Request 5 重组后的 History 逐层核对。20 个稳定状态分别在 1920×1080 与 1024×576 下审查：入口镜头只冻结一个点击波纹；协议顺序按 1→2 展开；History 按 1→2→3 展开，其中编号 1 在编号 2 出现时降级、在编号 3 出现前退出，编号 2 只作为弱化对照保留。首次取帧误在 700ms 页面淡入期间截图，整批发白，因此全部拒绝；播放器随后增加仅供制作验收的 `review=1` 冻结模式，关闭页面转场和标注动画，但不改变正常播放。重录后编号、框线、点击中心、字幕安全区和双尺寸构图均通过，未使用箭头。联系表和事实边界见 `assets/demo/source/codex-compact/manifest.json`。

发布会视觉基线建立后，Codex compact 的片尾对比页又做了一次 1024×576 压力测试。原来的三条协议句会让第三项前的箭头孤立换行，因此 v0.2 只在流程行保留 `Codex：Responses`、`API：compact`、`Claude：continuation` 三个短节拍，把 `/responses/compact` 的精确边界移到页脚；两档 20 个复核点随后全部重生成并逐帧抽查。旧 v0.1 MP4 因标题卡已经变化而降为历史参考，待所有者确认故事后再重导。

整章录制前的原尺寸复核又发现，总览镜头的两个框实际向上错了一个事件：编号 1 落在 Turn 2，编号 2 落在普通 Request 3。纠正到真实 Turn 3 与其中的压缩 Request 4 后，只替换四张受影响的双尺寸帧并重建两张联系表。随后在干净提交 `e94bf4891fa95b5b53afd5bf22f411d54571a3be` 完整录制 250 秒无声画面母版：7500 帧、1556 个浏览器重绘帧、约 6.61 MiB，浏览器最终时间为 249972ms，编码最大实时延迟 2.755ms。整片完整解码和黑帧检查通过；从成片重新抽取 20 个 `review_points` 逐张查看，修正后的两级导航、Metadata 归因、九项协议顺序、Harness checkpoint、History 1→2→3 和最终 Response 均未错位。与已审阅 1920×1080 帧比较的平均绝对像素差为 2.18/255，最大 2.92/255 出现在 Harness prompt 镜头，原尺寸复核确认属于渲染差异。MP4、render manifest、抽帧和联系表仍只位于 Git 忽略的 `tmp/storyboard-video/codex-compact/`。

为避免后续章节再次依赖一次性浏览器会话，`scripts/capture-storyboard-review-frames.mjs` 已把上述操作收束为 catalog 驱动的命令。使用 Chrome 150 在隔离输出目录重生成 Codex compact 的 40 张帧和两张联系表后，所有文件都通过 JPEG 格式与真实尺寸校验；与当前已提交帧逐像素比较的平均绝对差为 2.40/255，最大单帧为 3.41/255，联系表肉眼一致，因此没有为了更换截图工具而重写现有二进制素材。正式更新时仍须打开联系表和代表性原图自审，自动生成成功不能代替视觉判断。

同日，“Skill 怎样被发现和加载”从 32 张旧式审阅帧迁移为时间线声明的 31 个稳定复核点，并重新生成真实 1920×1080 与 1024×576 两档画面。System、Tools 和协议视图标签已经能够自我解释，只保留轻描边；编号留给 Request 入口、调用、参数、回执、Raw 命中和最终证据。相关的调用与参数允许约半秒共存，焦点已经改变的标记交叉淡出，最终 Response 使用点击波纹后再出现单一证据编号。两档逐帧检查确认编号居中、框线未遮挡正文，并且不需要箭头。联系表和事实边界见 `assets/demo/source/claude-skill/manifest.json`。

随后在干净提交 `86b8ec1ace4f2e52ca4a1f0e902172b144be6561` 完整录制该章 239 秒无声画面母版：7170 帧、1610 个浏览器重绘帧、约 4.88 MiB，浏览器最终时间为 238936ms，编码最大实时延迟 10.293ms。整片完整解码和黑帧检查通过；从成片重新抽取 31 个 `review_points` 逐张查看，完整三栏、编号居中、点击入口、Skill 正文、协议顺序和最终 Response 均未错位。与已审阅 1920×1080 帧比较的平均绝对像素差为 3.48/255，最大 7.05/255 出现在无标注的片尾标题卡，复核后确认属于浏览器渲染差异而不是标注位移。MP4、render manifest、抽帧和联系表仍只位于 Git 忽略的 `tmp/storyboard-video/claude-skill/`。

同日，“子 Agent 在哪里运行，结果怎样回来”从 33 张未声明复核点的旧审阅图迁移为时间线中的 32 个稳定 `review_points`。multi-agent 镜头先用短波纹指示真实展开控件，再让两个分支编号 1、2 依次出现；Turn 2 / Turn 3 对照保留旧编号，但在新阶段出现前通过 `dim_ms` 退为次要；最终 Response 也改为点击波纹后只保留一个证据编号。第一轮自审还发现 Turn 2 降级状态比“显示 Turn 3”的字幕晚约一秒，修正时码后只重渲染相关帧。真实 1920×1080 与 1024×576 两档均通过，未使用箭头。联系表和事实边界见 `assets/demo/source/claude-subagents/manifest.json`。

随后先把旁白母稿中遗留的旧编号方案和一处 Request 编号校正到 v0.3 时间线，再在干净提交 `02720e350dcef1c6320d18ccafd9ef10da2b7a2b` 完整录制 254 秒无声画面母版：7620 帧、1763 个浏览器重绘帧、约 5.75 MiB，浏览器最终时间为 253945ms，编码最大实时延迟 57.69ms。整片完整解码和黑帧检查通过；从成片重新抽取 32 个 `review_points` 逐张查看，完整三栏、multi-agent 点击、两个分支交接、Turn 2 降权、Turn 3 对照和最终 Response 均未错位。与已审阅 1920×1080 帧比较的平均绝对像素差为 4.19/255，最大 7.51/255 出现在无标注的片尾标题卡，复核后确认属于浏览器渲染差异而不是标注位移。MP4、render manifest、抽帧和联系表仍只位于 Git 忽略的 `tmp/storyboard-video/claude-subagents/`。

同日，“自研 Harness 怎样通过通用协议先接入”用真实 `pma observe` 包装两条确定性 Source：OpenAI Responses 与 Anthropic Messages 都是 1 Turn / 2 Request，只完成列目录、回传结果和最终回答。第一轮 Raw 暴露了仓库工作目录，因此整批素材被拒绝并改用固定 `/tmp/pma-custom-harness-demo/public-project` 后重录。25 个稳定状态随后分别在 1920×1080 与 1024×576 下逐张放大检查：编号按旁白逐个出现；OpenAI input / output 依次交接焦点；Anthropic 的 `tool_use` 在 `tool_result` 出现后降权；其余独立焦点交叉淡出。框、编号和字幕已经足以引导视线，所以没有添加箭头。完整镜头脚本、校验值和脱敏边界见 `assets/demo/source/custom-harness/manifest.json`。

整章导出前的成片抽帧复核又发现，四个名为交接或下行的检查点实际采在新标注出现前，OpenAI 协议段的两个框也沿用旧布局而整体偏高：编号 1 没有落在三类 input Item，编号 2 没有落在最终 Assistant message。检查点移到真实重叠中段或完成态、两个框重新对齐后，在干净提交 `b1016742c113ecdb09cb76d6a18696f81a284fcb` 完整录制 251 秒无声画面母版：7530 帧、1322 个浏览器重绘帧、约 5.08 MiB，浏览器最终时间为 250970ms，编码最大实时延迟 67.239ms。整片完整解码和黑帧检查通过；从最终 MP4 重新抽取 25 个点逐张查看，三组交接都只短暂重叠，OpenAI input / output 与 Anthropic 降权对照均落在真实证据上。排除母版主动隐藏的网页字幕区域后，与已审阅 1920×1080 帧比较的平均绝对像素差为 1.41/255，最大 1.98/255 出现在 Raw Header 脱敏镜头，原尺寸复核确认属于渲染差异而不是标注错位。MP4、render manifest、抽帧和联系表仍只位于 Git 忽略的 `tmp/storyboard-video/custom-harness/`。

同日，“协议视图与 Raw：定位一次 call id 异常”使用真实 Capture Proxy 和确定性 OpenAI Responses 假上游生成 1 Turn / 3 Request：Request 2 回传错误 ID 并收到 HTTP 400，Request 3 修正后成功。第一次采集发现切换 Request 后仍残留上一次 Raw 搜索，且活动 Request 已变成 Request 3，因此拒绝了两张画面，清空搜索并断言右栏标题后局部重录。20 个渐进状态随后分别在真实 1920×1080 与 1024×576 下逐张检查：入口和证据是独立焦点时旧编号退场；正确值与错误值、错误对象与 HTTP 状态、request 与 response fidelity 需要对照时，编号 1 在编号 2 出现后保留但降权。所有编号均视觉居中，字幕保持底部居中，聚焦框未覆盖字段；右栏本身已经提供直接空间关系，因此没有添加箭头。完整镜头脚本、原始帧校验值与事实边界见 `assets/demo/source/protocol-raw/manifest.json`。

同一轮发布会风格复核把协议章节片尾的五项清单压缩为四步：时间线定位、协议路径、Raw / Response、provenance + 验证。这样在 1024×576 仍能一行扫读，同时没有删除旁白中的完整排错顺序。20 个双档复核点改用当前统一生成器的 JPEG 输出，替换了早期调色板 PNG，避免后续重录时出现相同文件名的两套格式；旧 v0.1 MP4 同样只保留为历史参考。

录制前又用当前 HEAD 重新运行同一确定性 Source，并通过实际 1920×1080 Viewer 操作确认幕后请求时间线、Request 2、协议视图和 `Schema 未识别` 入口仍与镜头一致。官方协议复核进一步明确：`compatibility_note` 是人为加入的非标准项；`function_call` 与 `function_call_output` 是通过 `call_id` 关联的 typed Item，Viewer 的 assistant / tool 只是语义标签。更新文案后的第一次 1024 复核帧因浏览器从 1920 缩放后尚未稳定而被拒绝，只有在断言 1024×576 viewport 和满画布边界后才重录。随后在干净提交 `2d616e5e61461c2dd421bf12130ff116619b543d` 完整录制 238 秒无声画面母版：7140 帧、1244 个浏览器重绘帧、约 5.13 MiB，浏览器最终时间为 237933ms，编码最大实时延迟 155.546ms。整片完整解码和黑帧检查通过；从最终 MP4 重抽 20 个稳定点并另查 27 个转场前、中、后画面，未知项、错 ID、HTTP 400、provenance 和修正闭环均未错位。用同一提交重新生成的 1920 JPEG 作为可复现几何基准后，平均绝对像素差为 0.42/255，最大 0.87/255 出现在无标注的片尾标题卡。旧调色板 PNG 会把该数值放大到 5.46/255，因此不再用它判断几何偏移。MP4、render manifest、抽帧和联系表仍只位于 Git 忽略的 `tmp/storyboard-video/protocol-raw/`。

同日，“翻译不改原文：读懂长 System 与 Tools”使用真实 Capture Proxy、确定性 OpenAI Responses 模型上游和确定性翻译上游生成 1 Turn / 2 Request。Request 1 带三块 System 和两个 Tools 上行，Request 2 回传目录工具结果并回答。18 个渐进状态分别在 1920×1080 与 1024×576 下逐张检查。第一轮发现编号 1 误框搜索框而不是翻译选择器；第二轮又发现英文原文聚焦框包含下一张 System 卡片，两处都局部修正并重渲染。最终镜头按旁白先出现 1，再出现 2；System 译文与对应原文需要比较时，1 保留但降权；独立入口则交叉淡出。编号居中、字幕保持底部中央、框线没有遮住 schema 标识符，空间关系清楚，因此未添加箭头。完整脚本、双尺寸联系表、校验值和翻译质量边界见 `assets/demo/source/translation/manifest.json`。

录制前又在当前 HEAD 重新生成确定性 Source，并通过实际 Viewer 操作确认目标语言选择器、Request 1 详情、System `3/3 已缓存`、Tools `7/7 已缓存`、对应英文原文、未翻译的工具 / 参数标识符，以及完整请求中的 `[REDACTED:header]` 都与镜头一致。随后在干净提交 `ddb8dd06502da613a771eb4a11cdebb58d4cea37` 完整录制 208 秒无声画面母版：6240 帧、1069 个浏览器重绘帧、约 4.01 MiB，浏览器最终时间为 207972ms，编码最大实时延迟 58.25ms。整片完整解码、10% 黑电平黑帧检查、音轨 / 字幕轨 / 网页字幕层检查均通过；从最终 MP4 重抽 18 个稳定点并另查 24 个转场前、中、后画面，目标语言、三块 System、双语展开、两个 Tools、七条说明材料、Raw 原文和 Header 脱敏均未错位。排除审校稿底部字幕区域后，与本次重新生成的 1920 JPEG 比较，平均绝对像素差为 0.394/255，最大 0.843/255 出现在无标注的片头标题卡。MP4、render manifest、抽帧和联系表仍只位于 Git 忽略的 `tmp/storyboard-video/translation/`。

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
