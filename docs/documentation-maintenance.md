# 用户文档与演示素材持续更新机制

本文定义功能 Agent 与文档 Agent 之间的长期协作方式。它区分共享仓库门禁、产品所有者主工作区已经启用的 Codex heartbeat，以及尚未接入的 GitHub 合并事件触发；不能把某一台机器上的本地自动化写成所有贡献者都具备的仓库能力。

## 当前已经具备

- `origin/main` 和精确 commit SHA 是功能事实来源；
- `docs/user-guide.md` 是任务式用户手册入口；
- `scripts/readme-media-demo.mjs` 可重建快速上手轨迹；
- `scripts/user-guide-media-demo.mjs --verify` 可重建并断言上下文、迟到结果和子 Agent 三条轨迹；
- `scripts/claude-mechanisms-media-demo.mjs --verify` 保留 Claude 机制的合成分类合约；Skill、子 Agent、压缩和多步规划的当前发布事实分别以四个 `claude-*-real-cli-probe.mjs`、对应 manifest 和双尺寸审阅帧为准；Codex 压缩事实由 `codex-compact-real-cli-probe.mjs`、真实 App Server Capture 和独立双尺寸审阅帧约束；
- `scripts/translation-viewer-demo.mjs` 可通过真实 Capture Proxy、真实翻译接口与两个确定性 loopback 上游重建 3 个 System、7 个 Tools 翻译块及原文兜底场景；
- `scripts/build-readme-media.py` 可从保留的原始帧重新生成标注图和慢速 GIF；
- `scripts/build-demo-video.py` 可从已验收素材重新生成中文 MP4、旁白、字幕、封面与中性时间线；
- `scripts/capture-storyboard-review-frames.mjs <chapter>` 可直接读取 catalog 与时间线，用环回服务器和一次性 Chrome 重建 1920×1080 / 1024×576 审阅帧及联系表；它验证真实 JPEG 像素，不需要 Playwright，也不会自动删除失效旧帧；
- `scripts/export-storyboard-video.mjs <chapter>` 可把任意 catalog 章节的真实网页播放录制为 1920×1080、30 fps、H.264 干净画面母版；默认无网页字幕、音轨或字幕轨，切片和带字幕内部预览使用显式参数，旁车 render manifest 记录精确 HEAD、工作区状态、工具版本、范围、帧数和环回隐私边界；
- `scripts/generate-storyboard-review-index.mjs` 可把同一 catalog、时间线和本地 render manifest 汇成 Git 忽略的统一审片首页；十章的 HTML 模板、无字幕干净播放、本地 MP4、中文章节、Source 边界、状态和下一道门无需再手工拼链接，历史切片与正式母版分开显示；逐章结论和备注只存于按候选 SHA 隔离的浏览器 `localStorage`，由所有者显式导出带精确 SHA 的 JSON，页面不会上传数据或自动改 catalog；`--check` 可只验证页面合同，`--require-videos` 用于本机正式母版交接；
- `scripts/storyboard-review-handoff.mjs` 负责接收上述 JSON：它核对 schema、精确候选 SHA、干净工作区、十章顺序、结论计数、时间戳和常见敏感内容哨兵；默认摘要隐藏备注原文，`--show-notes` 只能写入 Git 忽略的 `tmp/`，脚本不会修改 catalog、创建 GitHub 内容或发布媒体；
- `assets/demo/storyboard/` 可从章节时间线非破坏性播放真实 Viewer 帧、字幕、聚焦框、标注和转场；统一 catalog 还把十个演示章节映射到对应中文手册小节，并保存问题、观众、Source 边界、审阅状态、下一道门与五类资料入口；`review=1` 可冻结指定时点用于逐帧验收，制作模式可以直接打开，成片模式不会显示；`scripts/demo-storyboard-smoke.mjs` 检查镜头连续性、可读时长、素材路径与箭头草稿；
- `scripts/demo-production-audit.mjs` 跨章节核对 manifest、旁白、时间线、SRT、Source 图片、双尺寸审阅帧的真实像素、Git 可追踪性、媒体体积预算、章节审阅合同与常见隐私哨兵；catalog 中的叙事合同还要求开场在 30 秒内完成、PMA 价值在 60 秒内讲明、至少两个 Viewer 证据镜头真实存在、结尾能回到可复述结论；带 `review_points` 的章节可用 `--strict` 要求两档帧与稳定时点逐一对应；`smoke:governance` 会调用这项生产审计；
- `scripts/documentation-consistency-audit.mjs` 核对中英文 README、快速开始、用户手册首页与十个任务章节的本地链接和章节锚点；同时检查 Node.js 要求、九条核心 CLI 事实、英文首页的支持协议/主 GIF/中文深读入口，以及十个演示章节到真实中文标题和审阅合同的映射；它已经由 `smoke:governance` 调用；
- 同一脚本的 `--base` / `--changed-file` 模式会把功能变更映射成受影响文档与演示素材；JSON 同时包含精确目标 SHA、解析后的 base SHA、工作区状态、去重后的必查文档、必查演示和具体章节 id、验证命令与隐私限制，可以直接作为文档 Agent 的任务载荷；
- `scripts/demo-freshness-audit.mjs` 把“演示可能过时”拆成三类可验证结论：catalog 中已经在共享 `main` 完成产品复核的检查点之后，当前章节关注的运行时代码是否变化；章节的 Source 生成脚本更新后，Source 图片与 manifest 是否重建；以及共享播放器、当前时间线或 Source 图片更新后，已提交双尺寸复核帧是否重生成。报告同时保留 manifest 的原始采集 SHA 作为 provenance，但不要求 squash merge 后的分支提交永久可达。默认模式只报告而不阻断；只有完成真实 Viewer 复核并准备交接时才使用 `--strict`；
- `.github/workflows/release-check.yml` 已在每个 PR 增加只读 `Documentation impact` job：它检出精确 head SHA，以 PR base SHA 到 head SHA 的 merge-base 范围生成 JSON，再把受影响文档、演示 Source、验证命令和隐私限制写入 GitHub Job Summary；job 只有 `contents: read`，不会评论 PR、创建 issue、读取 secrets 或发布素材；
- `scripts/documentation-impact-summary.mjs` 负责校验 JSON 中的 head/base SHA 并生成防 Markdown 注入的摘要；路径很多时完整变更列表折叠显示，必查文档和演示保持在首屏；
- 产品所有者的主文档工作区已启用名为 `peekMyAgent documentation and demo drift monitor` 的 Codex heartbeat：每天本地时间 10:00 轻量轮询一次 `origin/main`，用 Git 忽略的 `tmp/documentation-main-monitor.json` 保存最后扫描 SHA，并复用同一 JSON 影响映射唤醒当前长期文档任务；没有新 SHA 或没有映射边界时不通知、不截图、不运行大检查；
- `docs/media-publishing.zh-CN.md` 规定主仓库只跟踪轻量、可复现的制作资料，成片通过 Releases 或对象存储发布；
- `docs/video-series-claude-code.zh-CN.md` 保存工具闭环、Skill、子 Agent、上下文压缩和多步规划五支独立视频的事实边界与逐镜头脚本；
- `docs/visual-usage-guide.zh-CN.md` 定义逐帧视觉验收门禁；
- `assets/demo/source/*/manifest.json` 记录视口、主题、协议、帧时长、隐私和预期语义。

这些能力可以发现确定性轨迹、素材生成失败和核心中文文档漂移，也能在 PR 上主动生成“变更文件 → 受影响文档 / 演示”的只读交接。主工作区 heartbeat 已能在合并后轮询 `origin/main` 并唤醒当前 Codex 文档任务；GitHub 仓库本身仍没有在 push 事件上创建 issue、外部任务或写回 PR 的权限。

## 功能到文档的影响矩阵

| 功能变更边界 | 必查文档 | 必查演示 |
| --- | --- | --- |
| `bin/`、安装、CLI help、wrapper 生命周期 | README、快速上手、观察会话、支持的 Harness、安全清理、排障 | 启动命令素材与 `smoke:cli` |
| `src/viewer/` 中任意画面、布局或交互 | README、快速上手、视觉使用指南与包含该画面的任务章节 | 所有包含真实 Viewer 画面的相关章节、双尺寸复核帧、静态封面与可控 HTML |
| Viewer 时间线、Turn / Request Rail | 快速上手、请求与上下文 | `quickstart` 可控章节、两级导航静态图与社交视频母版 |
| Request 详情、History、Context Delta、System diff | 请求与上下文、协议与 Raw | `codex-compact` 可控章节与 `context-system-diff.png` |
| 工具语义与来源关联 | 工具调用与迟到结果 | `claude-tool-loop` 可控章节与 `delayed-tool-result-arrives.png` |
| Skill 发现、加载、Harness 注入或通用 Skill 工具 | Skill 章节、支持的 Harness、协议与 Raw | Claude Code Skill 真实 CLI Source 与双尺寸审阅帧 |
| 子 Agent 归因与多 Agent 看板 | 子 Agent 章节 | Claude Code 子 Agent 真实 CLI Source 与双尺寸审阅帧 |
| 上下文压缩或多步任务状态 | 请求与上下文、工具调用 | Claude Code / Codex compact 与 planning 真实 CLI Source、精确协议边界和双尺寸审阅帧 |
| 协议投影、Raw Inspector、搜索或 provenance | 协议与 Raw、自研 Harness | `protocol-raw` 真实 Capture Proxy Source、双尺寸审阅帧与脱敏 manifest |
| 翻译、语言目录与主题 | 请求与上下文、素材说明 | `translation` 真实 Capture Proxy Source、确定性翻译缓存、原文对照帧与双尺寸审阅素材 |
| 隐私、导入导出、清理或卸载 | 安全清理、排障 | manifest 隐私字段与公开前检查 |
| 任一进入中文核心视频的 Viewer 画面或术语 | 视频制作说明、用户手册入口 | 对应合成帧、字幕、旁白与整片中点抽帧 |

功能 Agent 不需要直接重录所有素材，但必须在 PR 或交接中明确“影响 / 不影响”的矩阵行，并提供精确候选 SHA。

## 主动触发流程

当前 PR 检查、主工作区 heartbeat 与未来的仓库级合并事件自动化共用以下流程：

1. PR 事件读取精确 head/base 及其变更文件；主工作区 heartbeat 每天比较本地检查点与 `origin/main`；未来的仓库级自动化可以改为直接消费受信任的合并事件；
2. 根据上表映射到受影响章节和场景。仓库内可以直接运行：

   ```bash
   node scripts/documentation-consistency-audit.mjs --base origin/main --target HEAD
   node scripts/documentation-consistency-audit.mjs --base origin/main --target HEAD --json
   ```

   对尚未提交或由其他系统传入的单个路径，也可以重复使用 `--changed-file`：

   ```bash
   node scripts/documentation-consistency-audit.mjs \
     --changed-file src/viewer/raw-inspector-controller.js \
     --changed-file src/viewer/agent-graph-view.js \
     --json
   ```

   `--target` 与 `--base` 同时使用时按 merge-base 范围计算已提交变更，适合 PR 和可复现交接；只写 `--base` 时仍会把当前工作区与 base 比较，适合本地修改中的预览。无参数运行只执行一致性门禁，不生成影响报告。JSON 中 `working_tree_dirty: true` 表示当前检出仍有未提交内容，不能把它当作已完整包含这些修改的共享目标；交接前应提交到独立分支并重新生成；
3. 对 JSON 的 `required_demo_chapters` 运行章节新鲜度检查。无参数时检查十章，也可以重复 `--chapter` 只查本次受影响章节：

   ```bash
   node scripts/demo-freshness-audit.mjs --target HEAD
   node scripts/demo-freshness-audit.mjs --target HEAD \
     --chapter quickstart \
     --chapter claude-subagents \
     --json
   ```

   `product_evidence.status: review-required` 表示 catalog 的 `verified_product_sha` 之后，章节关注的 CLI、Capture、Viewer、工具、协议等运行时边界发生了变化，需要重新操作真实产品并判断 Source 是否失效；`capture_sha` 仍指向 manifest 的原始采集证据，不作为 squash 后的可达性前提。`source_recipe.status: regeneration-required` 表示该章的确定性生成脚本比 Source 图片与 manifest 更新；`tracked_review_frames.status: regeneration-required` 表示网页播放器、该章时间线或 Source 图比已提交复核帧更新，需要重新生成两档复核帧。三者互不替代：只改标注样式可能只要求重渲染，生成脚本变化要求重建 Source，产品功能变化则要求先复核真实产品；
4. 运行确定性 `--verify` 和现有文档检查；
5. PR job 把匹配结果写入只读 Job Summary；功能贡献者更新对应文档/manifest，或记录公开行为未变化的具体证据；
6. 主工作区 heartbeat 在发现新 SHA 后生成同结构 JSON，按 `target SHA + impact_ids` 去重；存在映射边界时对 `required_demo_chapters` 运行新鲜度检查并唤醒当前长期文档任务，没有映射时只更新检查点；
7. 任务必须携带目标 SHA、变更摘要、受影响章节、需要重新核对产品证据的章节、只需重渲染的章节和隐私限制；
8. 文档 Agent 在该 SHA 上操作真实 Viewer，局部重录和重新验收；
9. 中文事实稳定后再同步英文及其他语言。

当前 PR 检查只生成明确交接，不创建任务。主工作区 heartbeat 可以唤醒文档任务，但不能自动把 roadmap 文案发布为当前功能，或在没有视觉复核时自动提交新截图。

`.github/pull_request_template.md` 已要求功能贡献者检查自动生成的 Job Summary，并附上更新或“不影响”的证据。GitHub 现在会主动产出只读交接；主工作区 heartbeat 负责合并后的低频补漏；视觉判断和真实 Harness 复核继续由人或文档 Agent 完成。

## 当前工作区 heartbeat 合同

- 调度：每天本地时间 10:00 运行一次；只有 `origin/main` SHA 变化时才执行影响映射；
- 检查点：`tmp/documentation-main-monitor.json` 只保存 `schema_version`、`last_scanned_sha` 和用于去重的 `last_notified_key`，受 `.gitignore` 保护，不是共享项目状态；
- 任务载荷：必须包含精确 base/target SHA、变更文件、影响 id、必查文档、必查演示、具体章节 id、产品证据复核状态、Source 生成脚本状态、复核帧重生成状态、验证命令和敏感数据限制；
- 自动执行边界：允许只读核对当前仓库和真实 Viewer，并对明确的低风险文档漂移按小批更新；不允许修改产品运行时、协议适配或 Bug，不允许自动发布视频，也不允许覆盖其他贡献者的工作树；
- 通知：没有 SHA 变化、没有映射边界或同一 `target SHA + impact_ids` 已通知时保持安静；只在出现新影响、实际完成更新、验证失败或需要产品所有者决定时通知；
- 降级：本地 heartbeat 不可用时，PR 的只读 `Documentation impact` 仍是共享最低保证；其他机器不会因为克隆仓库而自动获得该调度。

## 功能 Agent 的最小交接

```text
Target SHA:
功能变化：
用户可见按钮/标签变化：
协议或 Capture 变化：
受影响章节：
受影响演示 Source：
是否需要真实 Harness 复核：
敏感数据限制：
```

如果功能没有影响用户文档，也要写出证据，例如“仅重构内部模块，CLI、Viewer DTO、文案和交互契约不变”。

## 文档 Agent 的完成标准

- 在目标 SHA 重新核对命令、标签和交互；
- 更新中文版章节和必要的英文事实；
- 重录时只使用非敏感项目与确定性上游；
- 保存原始帧、标注图、生成脚本和 manifest；
- 对每帧检查 2048×1056 与 900～1100px 预览；
- 视频素材先从网页时间线导出无字幕干净母版；同时检查 1920×1080、30 fps、无黑边、转场前后、编号逐次出现、整片抽帧、字幕时码、响度和编辑交接清单，发布画面的 render manifest 必须来自干净工作树且标记 `publishable_picture_master: true`；
- 运行 `git diff --check`、Markdown 安全、治理、链接与对应轨迹 `--verify`；
- 运行 `node scripts/documentation-consistency-audit.mjs`；功能分支再附上 `--base <base SHA> --target HEAD --json` 的影响报告；
- 对受影响章节运行 `node scripts/demo-freshness-audit.mjs --target HEAD --chapter <id>`；完成 Source 与复核帧更新后再用 `--strict` 作为交接门；
- 报告精确验证 SHA 和仍未覆盖的风险。

## 下一步自动化边界

“变更文件 → 影响矩阵 → 带精确 SHA 的 JSON 交接 → PR Job Summary → 人工确认”已经由权限受限的只读 GitHub 工作流执行；主工作区 heartbeat 又补上了“合并后轮询 → 去重 → 唤醒当前文档任务”。下一阶段若需要所有维护者共享同一触发，仍应在受信任的 `main` push 事件上复用同一 JSON，并明确任务承载位置、失败重试、关闭条件和谁确认真实 UI 录制。仓库级工作流在这些权限和治理问题确定前继续保持只读。
