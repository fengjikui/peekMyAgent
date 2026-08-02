# PMA 网页故事板

这个播放器把真实 Viewer 原始帧与章节 JSON 合成为可重复播放的画面母稿。聚焦框、标注卡、编号、箭头、字幕和转场都是网页层，不会写入原始截图。

快速上手的七张 Viewer 原始帧可通过 `node scripts/capture-readme-source-frames.mjs` 重建。脚本自行启动非敏感确定性轨迹，在 1920×1080 的真实 PMA Viewer 中按教学顺序操作详情、System、工具结果、来源、Response、协议视图和 Turn 5，再原子写入无浏览器边框、无烧录标注的 PNG；不需要手工缩放窗口或重新命名截图。

从仓库根目录启动静态服务器：

```bash
python3 -m http.server 43115 --bind 127.0.0.1
```

打开统一审阅入口：

```text
http://127.0.0.1:43115/assets/demo/storyboard/index.html
```

如果需要一次看到十章的 HTML、干净播放和本地 MP4，而不是逐个拼接链接，先生成 Git 忽略的统一审片首页：

```bash
node scripts/generate-storyboard-review-index.mjs --require-videos
```

再打开：

```text
http://127.0.0.1:43115/tmp/storyboard-video/review-index.html
```

这张首页直接读取 `catalog.zh-CN.json`、各章时间线和本地 render manifest，显示标题、时长、镜头、字幕、复核点、Source 边界、审阅状态与下一道门。catalog 同时保存每章的开场、产品价值、Viewer 证据和收束镜头合同，由生产审计阻止后续改版静默删掉关键叙事节拍。每章提供可点击的 HTML 模板、无字幕干净播放、正式 MP4、页内视频预览和对应中文章节；其他试剪只在折叠区标为历史素材。页面不会嵌入视频、Capture 或本机绝对路径，重新生成也不会把 `tmp/` 中的文件加入 Git。没有本地视频的克隆仍可生成页面；交接正式母版时增加 `--require-videos`，要求十章视频和 render manifest 全部通过合同核对。

审阅者可为每章选择“故事线通过 / 需要修改 / 暂缓决定”并留下短备注。记录只保存在当前浏览器的 `localStorage`，并按页面生成时的精确候选 SHA 隔离；切换候选提交不会沿用旧结论。只有点击“导出审阅 JSON”才会生成本地交接文件，页面不会上传数据，也不会自动修改 catalog 的发布状态。备注可能包含审阅者输入的敏感内容，分享导出文件前仍须人工检查；所有者确认后，由维护者手工更新 catalog 和对应文档。

收到导出的 JSON 后，先把文件放在 Git 忽略的 `tmp/`，只做结构、候选提交和隐私检查；不要先复制备注到 issue 或聊天：

```bash
node scripts/storyboard-review-handoff.mjs \
  --input tmp/storyboard-review/review.json \
  --expected-target <完整的四十位候选提交> \
  --check
```

默认摘要不会打印备注原文。需要整理修改清单时使用 `--output tmp/storyboard-review/summary.md`；只有明确需要阅读备注时才额外增加 `--show-notes`，且输出必须留在 `tmp/`。脚本会拒绝脏工作区候选、章节清单漂移、计数不一致和疑似密钥或隐私路径，而且不会回显命中的敏感值。`--allow-dirty` 只用于内部预览，不能据此更新 catalog；JSON 与含备注报告都不得进入 Git。

播放器默认打开五分钟快速上手。非成片模式的控制区包含两级选择器：

- `章节`：直接切换快速上手、自研 Harness 通用协议、协议与 Raw 排错、System / Tools 翻译、工具调用、Skill、子 Agent、Claude Code / Codex 上下文压缩和多步规划；
- `复核点`：跳到时间线声明的稳定 `review_points`，播放器自动暂停并更新可分享 URL；
- `对应章节`：打开 catalog 为当前演示声明的中文用户手册小节，让素材审阅和功能事实复核使用同一个入口；
- 选择器只属于制作审阅界面，`present=1` 时与其他控制器一起隐藏，不进入画面母版。

常用参数：

- `present=1`：隐藏控制栏并按浏览器画布播放；
- `autoplay=0`：停在当前镜头，适合逐帧验收；
- `scene=6`：直接打开从 0 开始计数的指定镜头；
- `at_ms=18000`：从当前镜头内的指定毫秒位置渲染，适合直接复核渐进标注，不必真实等待；
- `review=1`：把 `at_ms` 对应的标注状态冻结为静态审查帧，并关闭淡入、镜头运动与点击动画；只用于逐帧验收，不进入正式播放或录屏；
- `subtitles=0`：隐藏网页字幕层，用于生成可复用到其他语言的干净画面母版；默认审阅播放仍显示字幕；
- `timeline=/assets/.../timeline.zh-CN.json`：直接载入指定章节，章节选择器会同步当前值。

例如在 1920×1080 浏览器中复核 Skill 正文 Raw 镜头：

```text
http://127.0.0.1:43115/assets/demo/storyboard/index.html?present=1&review=1&autoplay=0&scene=6&at_ms=18000
```

`catalog.zh-CN.json` 是统一章节目录和审阅状态源。每个条目必须同时声明时间线、对应中文文档、真实标题，以及 `review` 中的目标问题、观众、Source 边界、状态、下一道确认门、五类审阅资料和本章依赖的产品影响 id。点击制作控制区的“章节审阅”即可在同一页面打开这份合同；它不会进入 `present=1` 成片。新增可发布章节时必须同步增加 catalog 条目；`demo-production-audit.mjs` 与 `documentation-consistency-audit.mjs` 会拒绝缺失章节、错误路径、未知产品边界、失效资料、未纳入中文公开文档审计的文件或不存在的小节标题。

改动产品、网页播放器、时间线或 Source 后，先检查哪些章节真的需要重看：

```bash
node scripts/demo-freshness-audit.mjs --target HEAD
node scripts/demo-freshness-audit.mjs --target HEAD --chapter quickstart --json
```

`product_evidence` 比较 manifest 中的精确产品证据 SHA 与目标提交，只关注 `bin/`、`src/`、`integrations/` 和包契约中的运行时变化；`source_recipe` 比较 manifest 声明的生成脚本与 Source 图片 / manifest 提交；`tracked_review_frames` 比较共享播放器、该章时间线和 Source 图片的最新提交与复核帧提交。默认命令是只读提示，允许在视觉方案尚未确认时保留旧复核帧；只有完成真实 Viewer 核对和对应重生成后才使用 `--strict` 作为交接门。

## 一条命令重生成双尺寸审阅帧

不需要手工启动静态服务器，也不需要安装 Playwright。下面的命令从 catalog 找到章节时间线和输出目录，启动只监听环回地址的临时服务器与一次性无痕 Chrome，再按全部 `review_points` 生成 JPEG 和两张联系表：

```bash
node scripts/capture-storyboard-review-frames.mjs codex-compact
node scripts/demo-production-audit.mjs --strict codex-compact
```

脚本自动查找 Chrome、Chromium 或 Edge；也可以通过 `--browser <path>` 或 `PMA_STORYBOARD_BROWSER` 指定。它固定使用 `present=1&review=1&autoplay=0`，等待源图和目标镜头完成，再调用浏览器原生截图并验证实际像素严格等于 1920×1080 或 1024×576。一次性浏览器 profile 会在结束时清理，网页和素材只从本地仓库读取。

修改时间线但暂时不想覆盖已提交素材时，先输出到隔离目录：

```bash
node scripts/capture-storyboard-review-frames.mjs codex-compact \
  --output-root tmp/codex-compact-review-candidate
```

脚本只覆盖时间线当前声明的同名帧，不会擅自删除旧文件；复核点被删除或改名后，严格生产审计会报告多余文件，再由制作者明确处理。

## 一条命令导出视频画面母版

审阅帧通过后，使用同一 catalog 和网页时间线直接录制真实 DOM / SVG 动画。无需手工调整浏览器窗口，也不把静态联系表重新伪装成视频：

```bash
node scripts/export-storyboard-video.mjs quickstart
```

默认输出到 `tmp/storyboard-video/quickstart/pma-quickstart-picture.mp4`，旁边同时生成 `.render.json`。母版固定为 1920×1080、30 fps、H.264；没有音轨和字幕轨，网页字幕层也默认隐藏。浏览器仅从临时环回服务器读取仓库素材，MP4 与 render manifest 都位于 Git 忽略目录。

首次检查新章节时先导出一个包含目标转场或编号交接的切片：

```bash
node scripts/export-storyboard-video.mjs quickstart \
  --start-seconds 78 \
  --duration-seconds 16 \
  --output tmp/storyboard-video/quickstart/system-sequence.mp4
```

需要确认电影式字幕位置时显式传入 `--include-subtitles`；这只生成内部字幕预览，不替代独立 SRT，也不能作为多语言干净母版：

```bash
node scripts/export-storyboard-video.mjs quickstart \
  --include-subtitles \
  --output tmp/storyboard-video/quickstart/pma-quickstart-captioned-preview.mp4
```

脚本先把浏览器连续画面流编码到同目录临时文件，核对分辨率、帧率、帧数、时长、视频编码以及不存在音频/字幕流后才替换目标。render manifest 记录精确 HEAD、工作区是否干净、源时间线、浏览器、FFmpeg、范围、帧数和隐私边界；只有“干净工作区、整章、无网页字幕”同时成立时，`publishable_picture_master` 才为 `true`。正式发布仍必须真实观看成片并抽查转场、渐进编号和末帧。

## 统一入口视觉复核记录

2026-08-02 使用真实浏览器完成以下检查：

- 1920×1080 制作模式首屏完整显示 16:9 舞台、播放控制、章节和复核点选择器，没有水平或垂直溢出；
- 1024×576 制作模式保持 973×547 的完整舞台和零水平溢出，向下滚动后两级选择器完整可见；
- `present=1` 在两档尺寸下分别严格占满 1920×1080 与 1024×576，控制区均为 `display: none`；
- 十个 catalog 章节全部可以切换，分别载入 `28、25、20、18、36、31、32、15、20、28` 个复核点；
- 子 Agent 分支交接实测为“只有 1 → 短暂 1+2 → 只有 2”，异步完成对照实测为“1 → 1 降级 → 降级的 1 与当前 2 共存”；
- 从复核点继续播放后，选择器会立即退出旧选中状态，避免把已经离开的时刻误显示为当前复核点。
- 十个章节分别映射到快速上手、通用协议工具闭环、协议与 Raw 排错、System / Tools 翻译、工具四层证据、Skill 四层模型、子 Agent 机制流程、Claude Code 压缩、Codex 压缩和七 Request 多步规划小节；1920×1080 与 1024×576 均无水平溢出，`present=1` 下文档入口不可见。
- 十个章节的审阅面板分别显示本章问题、目标观众、真实 / 确定性 Source 边界、待确认门，以及旁白、SRT、manifest、1920 与 1024 联系表入口；这些入口同样只存在于制作模式。
- Codex 压缩章的 20 个复核点还验证了冻结审查模式：点击波纹保持在实际入口中心；编号按 1→2→3 出现，旧编号根据比较关系降级或退出，而不是一次叠满。
- 干净提交 `ec33fd6282af42ab146b787a4bd31d791e483edb` 已用通用导出器完整录制 251 秒快速上手母版；7530 帧、28 个时间线复核点抽帧、完整 1920×1080 构图和无黑边 / 无字幕层检查通过。候选 MP4 与 render manifest 只保存在 Git 忽略目录，尚未作为公开成片发布。
- Claude Code 工具闭环 v0.3 已通过自动脚本重录十张 1920×1080 Claude 主题 Source，并重生成 36 个复核点的 1920×1080 / 1024×576 审阅帧；原尺寸检查修正了右栏框线穿字和编号压字。提交 `4bb27179a4e893cc986e7016a87515a0a0066314` 的 245 秒母版只对应旧 v0.2 Source，当前版本须在所有者确认故事后重新导出。
- 干净提交 `86b8ec1ace4f2e52ca4a1f0e902172b144be6561` 已完整录制 239 秒 Claude Code Skill 母版；7170 帧和 31 个复核点通过完整解码、黑帧、三栏构图、编号居中、渐进交接、Skill 正文、协议顺序与无字幕层检查。该候选仍只保存在 Git 忽略目录，所有者中文故事审阅尚未完成。
- 干净提交 `02720e350dcef1c6320d18ccafd9ef10da2b7a2b` 已完整录制 254 秒 Claude Code 子 Agent 母版；7620 帧和 32 个复核点通过完整解码、黑帧、三栏构图、multi-agent 点击、分支交接、Turn 降权对照、最终 Response 与无字幕层检查。该候选仍只保存在 Git 忽略目录，所有者中文故事审阅尚未完成。
- 干净提交 `28d66330bfa44edb9b5521158af81fc21b109fc1` 已完整录制 242 秒 Claude Code 上下文压缩母版；7260 帧和 15 个复核点通过完整解码、黑帧、两级导航、History 重建、规则重载、渐进编号与无字幕层检查。该候选仍只保存在 Git 忽略目录，所有者中文故事审阅尚未完成。
- 干净提交 `e94bf4891fa95b5b53afd5bf22f411d54571a3be` 已完整录制 250 秒 Codex 上下文压缩母版；7500 帧和 20 个复核点通过完整解码、黑帧、两级导航、Metadata 归因、协议顺序、History 1→2→3 与无字幕层检查。该候选仍只保存在 Git 忽略目录，所有者中文故事审阅尚未完成。
- 干净提交 `d6b8e8720955354984822cf9b8f9d67d1cb6b66e` 已完整录制 274 秒 Claude Code 多步规划母版；8220 帧和 28 个复核点通过完整解码、黑帧、Turn / Request 两级导航、任务状态、文件证据、Message / History 边界、协议顺序、渐进编号与无字幕层检查。该候选仍只保存在 Git 忽略目录，所有者中文故事审阅尚未完成。
- 干净提交 `b1016742c113ecdb09cb76d6a18696f81a284fcb` 已完整录制 251 秒自研 Harness 通用协议母版；7530 帧和 25 个复核点通过完整解码、黑帧、OpenAI / Anthropic 配色、工具闭环、Metadata / Tools / 协议 / Raw、Header 脱敏、渐进交接与无字幕层检查。该候选仍只保存在 Git 忽略目录，所有者中文故事审阅尚未完成。
- 干净提交 `2d616e5e61461c2dd421bf12130ff116619b543d` 已完整录制 238 秒协议与 Raw 排错母版；7140 帧、20 个复核点和 27 个转场检查帧通过完整解码、黑帧、失败 Request 定位、未知项边界、Raw call id 对照、HTTP 400、exact provenance、修正验证与无字幕层检查。该候选仍只保存在 Git 忽略目录，所有者中文故事审阅尚未完成。
- 干净提交 `ddb8dd06502da613a771eb4a11cdebb58d4cea37` 已完整录制 208 秒 System / Tools 翻译母版；6240 帧、18 个复核点和 24 个转场检查帧通过完整解码、黑帧、目标语言、3/3 System、7/7 Tools、对应原文、Raw 脱敏、协议标识符保留与无字幕层检查。该候选仍只保存在 Git 忽略目录，所有者中文故事审阅尚未完成。

加载子 Agent 章节：

```text
http://127.0.0.1:43115/assets/demo/storyboard/index.html?timeline=/assets/demo/source/claude-subagents/video/timeline.zh-CN.json
```

加载上下文压缩章节：

```text
http://127.0.0.1:43115/assets/demo/storyboard/index.html?timeline=/assets/demo/source/claude-compact/video/timeline.zh-CN.json
```

加载 Codex 上下文压缩章节：

```text
http://127.0.0.1:43115/assets/demo/storyboard/index.html?timeline=/assets/demo/source/codex-compact/video/timeline.zh-CN.json
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

加载 System / Tools 翻译章节：

```text
http://127.0.0.1:43115/assets/demo/storyboard/index.html?timeline=/assets/demo/source/translation/video/timeline.zh-CN.json
```

加载 Claude Code 工具调用章节：

```text
http://127.0.0.1:43115/assets/demo/storyboard/index.html?timeline=/assets/demo/source/claude-tool-loop/video/timeline.zh-CN.json
```

修改时间线后运行：

```bash
node scripts/demo-storyboard-smoke.mjs assets/demo/source/claude-skill/video/timeline.zh-CN.json
```

快速上手、自研 Harness、协议与 Raw 排错、System / Tools 翻译、Claude Code 工具调用、Skill、子 Agent、Claude Code / Codex 上下文压缩和多步规划时间线都声明了 `review_points`。每个点包含稳定名称、镜头序号和镜头内毫秒位置，用来重复生成“旧重点、交叉淡化、新重点、保留但降级”两种视口的逐帧审阅稿。编号必须按讲解顺序逐个出现；前一编号是否保留、降级或退出由镜头中的比较关系决定，不能在镜头开始时一次叠出全部编号。契约检查会拒绝同一时刻出现的多个数字编号；旧编号若在新编号出现一秒后仍然存在，则必须已经通过 `dim_ms` 退为次要。它也会拒绝重复名称、越界镜头或超出镜头时长的复核点：

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

System / Tools 翻译章节：

```bash
node scripts/demo-storyboard-smoke.mjs \
  assets/demo/source/translation/video/timeline.zh-CN.json
node scripts/demo-production-audit.mjs --strict translation
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

Codex 上下文压缩章节同样要求冻结审查帧与时间线逐点一致：

```bash
node scripts/demo-storyboard-smoke.mjs assets/demo/source/codex-compact/video/timeline.zh-CN.json
node scripts/demo-production-audit.mjs --strict codex-compact
```

每个章节都应传入自己的时间线，不依赖播放器中的默认值。

由时间线重新生成独立字幕：

```bash
node scripts/timeline-subtitles-to-srt.mjs \
  assets/demo/source/claude-planning/video/timeline.zh-CN.json \
  assets/demo/video/pma-claude-planning.zh-CN.srt
```

播放器不会替代真实页面录制。`source_image` 必须来自当前 PMA Viewer，故事板只负责组织镜头和非破坏性标注。

标注以 `delay_ms` 控制出现；需要在后续重点出现时淡出的标注可以增加相对本镜头的 `end_ms`。不写 `end_ms` 表示保留到镜头结束，适合需要同时比较的编号；继续保留但需要退为次要时增加 `dim_ms`。编号表示讲解顺序，不是一次展示的图例：1、2、3、4 必须跟随旁白逐个出现，不能在镜头开始时同时铺满。先让 1 独立承担当前讲解，讲完 1 之后才允许出现 2；讲完 2 之后才允许出现 3，以此类推。相邻编号至少间隔 2.5 秒，具体时长仍以旁白真正讲完为准，不能把 2.5 秒当成机械倒计时。下一项出现时，上一项采用以下两种策略之一，并写进 `draft`：

- 仍需比较、回看或建立因果关系时，保留上一项，再叠加下一项；
- 讲解焦点已经转移、保留会增加噪声时，让上一项先渐隐或与下一项交叉淡化；通常保留约 0.4～0.7 秒的交接时间，交接完成后只留下当前重点；
- 旧编号继续保留时，应使用 `dim_ms` 降为次要视觉层级；是否保留由对照、因果或位置映射关系决定，不由最终编号数量决定。

标签本身已经清楚命名时，例如 System、Tools、Metadata、协议视图、完整请求和 Response，优先只使用 `type: "focus"` 的轻描边，不再叠加会遮住标题的编号。编号留给需要建立阅读顺序的动作和证据。

点击波纹自身应快速消失；轻描边、编号和文字也不默认永久保留。每个镜头的 `draft` 需要明确列出“出现顺序、保留关系、淡出时点”，逐个检查实际播放状态，而不是只审查最终叠满的静态帧。
