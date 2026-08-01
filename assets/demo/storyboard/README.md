# PMA 网页故事板

这个播放器把真实 Viewer 原始帧与章节 JSON 合成为可重复播放的画面母稿。聚焦框、标注卡、编号、箭头、字幕和转场都是网页层，不会写入原始截图。

从仓库根目录启动静态服务器：

```bash
python3 -m http.server 43115 --bind 127.0.0.1
```

打开统一审阅入口：

```text
http://127.0.0.1:43115/assets/demo/storyboard/index.html
```

播放器默认打开五分钟快速上手。非成片模式的控制区包含两级选择器：

- `章节`：直接切换快速上手、自研 Harness 通用协议、协议与 Raw 排错、工具调用、Skill、子 Agent、上下文压缩和多步规划；
- `复核点`：跳到时间线声明的稳定 `review_points`，播放器自动暂停并更新可分享 URL；
- `对应章节`：打开 catalog 为当前演示声明的中文用户手册小节，让素材审阅和功能事实复核使用同一个入口；
- 选择器只属于制作审阅界面，`present=1` 时与其他控制器一起隐藏，不进入画面母版。

常用参数：

- `present=1`：隐藏控制栏并按浏览器画布播放；
- `autoplay=0`：停在当前镜头，适合逐帧验收；
- `scene=6`：直接打开从 0 开始计数的指定镜头；
- `at_ms=18000`：从当前镜头内的指定毫秒位置渲染，适合直接复核渐进标注，不必真实等待；
- `timeline=/assets/.../timeline.zh-CN.json`：直接载入指定章节，章节选择器会同步当前值。

例如在 1920×1080 浏览器中复核 Skill 正文 Raw 镜头：

```text
http://127.0.0.1:43115/assets/demo/storyboard/index.html?present=1&autoplay=0&scene=6&at_ms=18000
```

`catalog.zh-CN.json` 是统一章节目录和审阅状态源。每个条目必须同时声明时间线、对应中文文档、真实标题，以及 `review` 中的目标问题、观众、Source 边界、状态、下一道确认门和五类审阅资料。点击制作控制区的“章节审阅”即可在同一页面打开这份合同；它不会进入 `present=1` 成片。新增可发布章节时必须同步增加 catalog 条目；`demo-production-audit.mjs` 与 `documentation-consistency-audit.mjs` 会拒绝缺失章节、错误路径、失效资料、未纳入中文公开文档审计的文件或不存在的小节标题。

## 统一入口视觉复核记录

2026-08-02 使用真实浏览器完成以下检查：

- 1920×1080 制作模式首屏完整显示 16:9 舞台、播放控制、章节和复核点选择器，没有水平或垂直溢出；
- 1024×576 制作模式保持 973×547 的完整舞台和零水平溢出，向下滚动后两级选择器完整可见；
- `present=1` 在两档尺寸下分别严格占满 1920×1080 与 1024×576，控制区均为 `display: none`；
- 八个 catalog 章节全部可以切换，分别载入 `28、25、20、36、31、32、15、28` 个复核点；
- 子 Agent 分支交接实测为“只有 1 → 短暂 1+2 → 只有 2”，异步完成对照实测为“1 → 1 降级 → 降级的 1 与当前 2 共存”；
- 从复核点继续播放后，选择器会立即退出旧选中状态，避免把已经离开的时刻误显示为当前复核点。
- 八个章节分别映射到快速上手、通用协议工具闭环、协议与 Raw 排错、工具四层证据、Skill 四层模型、子 Agent 机制流程、上下文压缩判断和七 Request 多步规划小节；1920×1080 与 1024×576 均无水平溢出，`present=1` 下文档入口不可见。
- 八个章节的审阅面板分别显示本章问题、目标观众、真实 / 确定性 Source 边界、待确认门，以及旁白、SRT、manifest、1920 与 1024 联系表入口；这些入口同样只存在于制作模式。

加载子 Agent 章节：

```text
http://127.0.0.1:43115/assets/demo/storyboard/index.html?timeline=/assets/demo/source/claude-subagents/video/timeline.zh-CN.json
```

加载上下文压缩章节：

```text
http://127.0.0.1:43115/assets/demo/storyboard/index.html?timeline=/assets/demo/source/claude-compact/video/timeline.zh-CN.json
```

加载多步任务章节：

```text
http://127.0.0.1:43115/assets/demo/storyboard/index.html?timeline=/assets/demo/source/claude-planning/video/timeline.zh-CN.json
```

加载五分钟快速上手：

```text
http://127.0.0.1:43115/assets/demo/storyboard/index.html?timeline=/assets/demo/source/quickstart/video/timeline.zh-CN.json
```

加载自研 Harness 通用协议章节：

```text
http://127.0.0.1:43115/assets/demo/storyboard/index.html?timeline=/assets/demo/source/custom-harness/video/timeline.zh-CN.json
```

加载协议与 Raw 排错章节：

```text
http://127.0.0.1:43115/assets/demo/storyboard/index.html?timeline=/assets/demo/source/protocol-raw/video/timeline.zh-CN.json
```

加载 Claude Code 工具调用章节：

```text
http://127.0.0.1:43115/assets/demo/storyboard/index.html?timeline=/assets/demo/source/claude-tool-loop/video/timeline.zh-CN.json
```

修改时间线后运行：

```bash
node scripts/demo-storyboard-smoke.mjs assets/demo/source/claude-skill/video/timeline.zh-CN.json
```

快速上手、自研 Harness、协议与 Raw 排错、Claude Code 工具调用、Skill、子 Agent、上下文压缩和多步规划时间线都声明了 `review_points`。每个点包含稳定名称、镜头序号和镜头内毫秒位置，用来重复生成“旧重点、交叉淡化、新重点、保留但降级”两种视口的逐帧审阅稿。编号必须按讲解顺序逐个出现；前一编号是否保留、降级或退出由镜头中的比较关系决定，不能在镜头开始时一次叠出全部编号。契约检查会拒绝同一时刻出现的多个数字编号；旧编号若在新编号出现一秒后仍然存在，则必须已经通过 `dim_ms` 退为次要。它也会拒绝重复名称、越界镜头或超出镜头时长的复核点：

```bash
node scripts/demo-storyboard-smoke.mjs \
  assets/demo/source/quickstart/video/timeline.zh-CN.json
```

工具调用章节：

```bash
node scripts/demo-storyboard-smoke.mjs \
  assets/demo/source/claude-tool-loop/video/timeline.zh-CN.json
```

协议与 Raw 排错章节：

```bash
node scripts/demo-storyboard-smoke.mjs \
  assets/demo/source/protocol-raw/video/timeline.zh-CN.json
node scripts/demo-production-audit.mjs --strict protocol-raw
```

Skill 章节同时执行可发布性严格检查：

```bash
node scripts/demo-storyboard-smoke.mjs \
  assets/demo/source/claude-skill/video/timeline.zh-CN.json
node scripts/demo-production-audit.mjs --strict claude-skill
```

多步规划章节同时执行可发布性严格检查：

```bash
node scripts/demo-storyboard-smoke.mjs \
  assets/demo/source/claude-planning/video/timeline.zh-CN.json
node scripts/demo-production-audit.mjs --strict claude-planning
```

子 Agent 章节同样要求两档文件名与时间线逐点一致：

```bash
node scripts/demo-storyboard-smoke.mjs assets/demo/source/claude-subagents/video/timeline.zh-CN.json
node scripts/demo-production-audit.mjs --strict claude-subagents
```

每个章节都应传入自己的时间线，不依赖播放器中的默认值。

由时间线重新生成独立字幕：

```bash
node scripts/timeline-subtitles-to-srt.mjs \
  assets/demo/source/claude-planning/video/timeline.zh-CN.json \
  assets/demo/video/pma-claude-planning.zh-CN.srt
```

播放器不会替代真实页面录制。`source_image` 必须来自当前 PMA Viewer，故事板只负责组织镜头和非破坏性标注。

标注以 `delay_ms` 控制出现；需要在后续重点出现时淡出的标注可以增加相对本镜头的 `end_ms`。不写 `end_ms` 表示保留到镜头结束，适合需要同时比较的编号；继续保留但需要退为次要时增加 `dim_ms`。编号表示讲解顺序，不是一次展示的图例：1、2、3、4 必须跟随旁白逐个出现，不能在镜头开始时同时铺满。下一项出现时，上一项采用以下两种策略之一，并写进 `draft`：

- 仍需比较、回看或建立因果关系时，保留上一项，再叠加下一项；
- 讲解焦点已经转移、保留会增加噪声时，让上一项先渐隐或与下一项交叉淡化；通常保留约 0.4～0.7 秒的交接时间，交接完成后只留下当前重点；
- 旧编号继续保留时，应使用 `dim_ms` 降为次要视觉层级；是否保留由对照、因果或位置映射关系决定，不由最终编号数量决定。

标签本身已经清楚命名时，例如 System、Tools、Metadata、协议视图、完整请求和 Response，优先只使用 `type: "focus"` 的轻描边，不再叠加会遮住标题的编号。编号留给需要建立阅读顺序的动作和证据。

点击波纹自身应快速消失；轻描边、编号和文字也不默认永久保留。每个镜头的 `draft` 需要明确列出“出现顺序、保留关系、淡出时点”，逐个检查实际播放状态，而不是只审查最终叠满的静态帧。
