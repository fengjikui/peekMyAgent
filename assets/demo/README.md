# Demo Media Assets

这个目录保存 README 和用户手册使用的公开演示素材。中文快速上手使用真实 PMA Viewer、确定性假上游和完全虚构的数据生成。

快速上手 v0.2 已迁移到网页故事板：旁白、字幕、镜头时码、渐进标注和 1920×1080 / 1024×576 审阅帧都来自 `source/quickstart/`。基于已复核帧生成的 74 秒主 GIF 候选版已经可供比较；当前 README 仍引用 v0.1 GIF，在所有者审阅中文故事前不提前替换首屏素材。

Claude Code 工具调用章节也已完成 v0.2 迁移：4 分 05 秒故事、51 条字幕、10 张无烧录标注的 Viewer 原始帧，以及两档各 36 张网页标注审阅帧位于 `source/claude-tool-loop/`。这条 Source 是确定性 Anthropic 教学轨迹；不得把它写成真实 provider 会话，真实 CLI 的交叉核对边界以 manifest 为准。

Claude Code 的 Skill、子 Agent、上下文压缩和多步规划章节分别位于 `source/claude-skill/`、`source/claude-subagents/`、`source/claude-compact/` 与 `source/claude-planning/`。自研 Harness 的 OpenAI / Anthropic 通用协议接入章节位于 `source/custom-harness/`；从错误 call id 追到 HTTP 400 的协议排错章节位于 `source/protocol-raw/`。两章都使用真实 PMA 捕获和确定性 loopback 假上游，不访问外部模型。已脱敏 Viewer 原图和双尺寸审阅帧属于可重建母稿；真实请求日志仍只保留在 Git 忽略的 `tmp/`。Skill 章已经把 31 个渐进状态写回时间线；子 Agent 章也已写入 32 个稳定复核点，并用点击波纹、顺序编号和 `dim_ms` 区分展开、分支与异步回流；多步规划章已经把 28 个稳定复核点写回时间线，并用像素审计纠正了早期“目录名为 1920、文件实际只有 1280×720”的问题。八章可以从 `storyboard/index.html` 的章节与复核点选择器统一审阅，并从同一制作控制区打开对应中文手册小节或“章节审阅”面板；问题、观众、Source 边界、待确认门与五类审阅资料都保存在 `storyboard/catalog.zh-CN.json`，不再依赖另一张手工状态表。

快速上手之后的上下文变化、迟到工具结果和子 Agent 素材见 [`user-guide/README.md`](user-guide/README.md)。

约 2 分 24 秒的中文核心能力视频初剪生成方法、字幕、封面和发布状态见 [`video/README.md`](video/README.md)。MP4 与独立配音默认在本地生成，不进入主仓库。

## 当前主素材

- `quickstart-tool-loop.gif`：从用户请求到工具闭环、最终回答和原始协议的慢速主 GIF，42.7 秒。
- `quickstart-tool-loop-v0.2-candidate.gif`：等待所有者审阅的 1024×576 候选版；17 个慢速镜头、65 帧、74 秒、约 5.6 MiB，尚未被 README 引用。
- `quickstart-overview.png`：2048×1056 无标注总览。
- `quickstart-overview-annotated.png`：带一个注意力标注的首帧。
- `quickstart/01-trace.png` ～ `quickstart/06-protocol.png`：六张章节标注图。
- `two-level-navigation.gif`：全局 Turn Rail 与轮内 Request Rail 的两帧慢速说明。
- `quickstart/07-two-level-navigation.png`：两级导航静态标注图。
- `source/quickstart/*-raw.png`：六张未标注的真实 Viewer 原始帧。
- `source/quickstart/manifest.json`：源提交、场景事实、视口、隐私边界、生成物与两档视觉复核结论。
- `source/quickstart/narration.zh-CN.md`：v0.2 教学合同与逐镜头旁白。
- `source/quickstart/video/timeline.zh-CN.json`：v0.2 网页故事板、48 条字幕母稿和 28 个逐帧复核点。
- `source/quickstart/readme-gif.zh-CN.json`：候选 GIF 的镜头选择、停留时长、字幕安全区、尺寸和体积门禁。
- `source/quickstart/recording/review-1920/`、`review-1024/`：两档渐进标注审阅帧与 contact sheet。
- `media-budget.json`：主仓库全部演示图片、GIF、单章素材与禁止音视频格式的机器门禁。
- `source/navigation/`：6 Turn / 13 Request 长轨迹原始帧与 manifest。
- `source/claude-tool-loop/manifest.json`：工具调用章节的教学合同、Source 类型、真实 CLI 交叉核对边界、隐私与两档视觉复核结论。
- `source/claude-tool-loop/video/timeline.zh-CN.json`：工具调用 v0.2 的 12 个镜头、51 条字幕和 36 个稳定复核点。
- `source/claude-tool-loop/recording/review-1920/`、`review-1024/`：工具调用章节两档渐进标注审阅帧与 contact sheet。
- `source/claude-skill/`：真实 Claude Code CLI 的 1 Turn / 3 Request Skill 加载轨迹、10 张原始帧、31 个渐进 `review_points` 和两档联系表。
- `source/claude-subagents/`：真实 Claude Code CLI 的 3 Turn / 8 Request 子 Agent 生命周期、11 张原始帧、32 个渐进 `review_points` 和两档联系表。
- `source/claude-compact/`：真实 compact 前后请求、旁白、41 条字幕、五张原始帧、15 个渐进 `review_points` 和两档联系表。
- `source/claude-planning/`：4 Turn / 10 Request 多步任务、54 条字幕、28 个 `review_points` 和两档联系表。
- `source/custom-harness/`：真实 `pma observe` 包装的 OpenAI Responses / Anthropic Messages 双协议工具闭环、8 张原始帧、47 条字幕、25 个渐进 `review_points` 和两档联系表。
- `source/protocol-raw/`：真实 Capture Proxy 捕获的错误 call id → HTTP 400 → 修正成功闭环、8 张原始帧、51 条字幕、20 个渐进 `review_points` 和两档联系表。

旧版 `dashboard-overview*`、`chat-upstream-context*` 和 `tool-call-loop*` 暂时保留，方便比较界面变化；当前中文版 README 不再引用它们。

## 重现

先启动确定性本地演示：

```bash
node scripts/readme-media-demo.mjs --port 43112
```

脚本会打印短轨迹与长轨迹两个 Source URL。在真实 Viewer 中将视口设为 2048×1056，并按对应 manifest 采集原始帧。随后运行：

```bash
python3 scripts/build-readme-media.py
```

脚本会重新生成所有 `quickstart-*` 发布素材。完整镜头脚本见 `docs/visual-usage-guide.zh-CN.md`。

v0.2 候选版只使用已经通过两档检查的故事板帧：

```bash
python3 scripts/build-readme-storyboard-gif.py
python3 scripts/build-readme-storyboard-gif.py --check
```

第一条命令重新合成候选 GIF；第二条只检查镜头源、尺寸、帧数、总时长和体积，不改写文件。

用户手册扩展素材使用另一条确定性脚本：

```bash
node scripts/user-guide-media-demo.mjs --port 43113
```

它会生成上下文演进、迟到工具结果和 Claude Code 双子 Agent 三个 Source。完整场景与隐私记录见 `source/user-guide/manifest.json`。

生成自研 Harness 的通用协议桥 Source：

```bash
node scripts/custom-harness-protocol-demo.mjs
```

脚本会创建固定虚构目录、启动确定性 OpenAI / Anthropic loopback 上游，并分别通过真实 `pma observe` 生成 1 Turn / 2 Request 的工具闭环。它不会访问外部模型；终端提示出现后按 `Ctrl-C` 清理临时 Viewer 与上游。

生成协议与 Raw 排错 Source：

```bash
node scripts/protocol-raw-debug-demo.mjs
```

脚本通过真实 Capture Proxy 生成 1 Turn / 3 Request：先取得工具调用，再故意回传错误 call id 并捕获 HTTP 400，最后修正并验证完整闭环。全部请求只访问 loopback，使用固定公开测试路径和占位认证值。

生成 Claude Code 工具闭环、Skill、五 Request 多步规划和 compact 分类合约 Source：

```bash
node scripts/claude-mechanisms-media-demo.mjs --port 43114
```

其中 compact Source 只用于验证 PMA 的分类契约；正式视频必须替换为当前 Claude Code 的真实压缩前后轨迹。逐镜头脚本见 `docs/video-series-claude-code.zh-CN.md`。

将已验收素材剪成中文讲解视频：

```bash
python3 scripts/build-demo-video.py
```

脚本在本地生成 MP4、M4A、SRT、封面、11 张合成帧和编辑器中性时间线。镜头脚本、ChatCut / 剪映调研与验收结果见 `docs/video-production.zh-CN.md`；发布和仓库体积规则见 `docs/media-publishing.zh-CN.md`。

修改任一章节后，先运行跨章节生产审计：

```bash
node scripts/demo-production-audit.mjs
```

它会读取图片字节核对真实像素，不接受只凭 `review-1920` 目录名或 manifest 声明尺寸；同时检查 SRT 是否仍由时间线生成、Source 与审阅帧能否进入干净克隆、八章是否映射到真实中文标题、所有下一次提交可纳入的演示媒体是否仍在体积预算内，以及常见本机路径和凭据形态。治理 smoke 会再次调用同一生产审计。

## 制作规则

- 只使用非敏感、可重现的 demo 会话。
- Codex 场景使用 Codex 主题；Claude Code 场景使用 Claude 主题。
- 保留全屏桌面信息密度；当前基准视口为 2048×1056，右侧详情标签后必须有明显余量。
- 一帧只传达一个重点，普通阅读画面至少 2.5～4 秒；v0.2 候选版按内容复杂度使用 3～7.5 秒，协议画面最长。
- v0.1 素材仍使用蓝框点击、红框结果；v0.2 网页故事板统一使用轻描边、小编号和短点击波纹。标签本身已有名称时不重复编号。
- 编号按旁白逐步出现；独立焦点交叉淡出，需要保留因果关系时用 `dim_ms` 把旧重点降为次要。
- 每条箭头必须先确定起点、终点、控制点和禁行区；生成后逐张打开完整分辨率图和 README 宽度预览，自审不满意就局部返工。完整门禁见 `docs/visual-usage-guide.zh-CN.md#逐帧视觉验收门禁`。
- 尽量将 GIF 控制在 8 MiB 内；当前发布版小于 2 MiB，v0.2 候选版约 5.6 MiB。
- 保存原始帧、标注图、manifest 和生成脚本，以便 UI 更新后局部重录。
- 分享前逐帧检查路径、提示词、源码、工具结果、认证信息和历史消息。
