# 用户文档与演示素材持续更新机制

本文定义功能 Agent 与文档 Agent 之间的长期协作方式。它区分当前已经具备的检查基础与尚未接入的主动触发计划，不能把计划写成已运行的自动化。

## 当前已经具备

- `origin/main` 和精确 commit SHA 是功能事实来源；
- `docs/user-guide.md` 是任务式用户手册入口；
- `scripts/readme-media-demo.mjs` 可重建快速上手轨迹；
- `scripts/user-guide-media-demo.mjs --verify` 可重建并断言上下文、迟到结果和子 Agent 三条轨迹；
- `scripts/claude-mechanisms-media-demo.mjs --verify` 保留 Claude 机制的合成分类合约；Skill、子 Agent、压缩和多步规划的当前发布事实分别以四个 `claude-*-real-cli-probe.mjs`、对应 manifest 和双尺寸审阅帧为准；
- `scripts/build-readme-media.py` 可从保留的原始帧重新生成标注图和慢速 GIF；
- `scripts/build-demo-video.py` 可从已验收素材重新生成中文 MP4、旁白、字幕、封面与中性时间线；
- `assets/demo/storyboard/` 可从章节时间线非破坏性播放真实 Viewer 帧、字幕、聚焦框、标注和转场；统一 catalog 还把六个演示章节映射到对应中文手册小节，并保存问题、观众、Source 边界、审阅状态、下一道门与五类资料入口；制作模式可以直接打开，成片模式不会显示；`scripts/demo-storyboard-smoke.mjs` 检查镜头连续性、可读时长、素材路径与箭头草稿；
- `scripts/demo-production-audit.mjs` 跨章节核对 manifest、旁白、时间线、SRT、Source 图片、双尺寸审阅帧的真实像素、Git 可追踪性、媒体体积预算、章节审阅合同与常见隐私哨兵；带 `review_points` 的章节可用 `--strict` 要求两档帧与稳定时点逐一对应；`smoke:governance` 会调用这项生产审计；
- `scripts/documentation-consistency-audit.mjs` 核对中英文 README、快速开始、用户手册首页与十个任务章节的本地链接和章节锚点；同时检查 Node.js 要求、九条核心 CLI 事实、英文首页的支持协议/主 GIF/中文深读入口，以及六个演示章节到真实中文标题和审阅合同的映射；它已经由 `smoke:governance` 调用；
- 同一脚本的 `--base` / `--changed-file` 模式会把功能变更映射成受影响文档与演示素材；JSON 同时包含精确目标 SHA、解析后的 base SHA、工作区状态、去重后的必查文档/演示、验证命令和隐私限制，可以直接作为文档 Agent 的任务载荷；
- `docs/media-publishing.zh-CN.md` 规定主仓库只跟踪轻量、可复现的制作资料，成片通过 Releases 或对象存储发布；
- `docs/video-series-claude-code.zh-CN.md` 保存工具闭环、Skill、子 Agent、上下文压缩和多步规划五支独立视频的事实边界与逐镜头脚本；
- `docs/visual-usage-guide.zh-CN.md` 定义逐帧视觉验收门禁；
- `assets/demo/source/*/manifest.json` 记录视口、主题、协议、帧时长、隐私和预期语义。

这些能力可以发现确定性轨迹、素材生成失败和核心中文文档漂移，也能生成“变更文件 → 受影响文档 / 演示”的结构化报告；当前还没有自动监听 `origin/main` 并创建外部文档任务。

## 功能到文档的影响矩阵

| 功能变更边界 | 必查文档 | 必查演示 |
| --- | --- | --- |
| `bin/`、安装、CLI help、wrapper 生命周期 | README、快速上手、观察会话、支持的 Harness、安全清理、排障 | 启动命令素材与 `smoke:cli` |
| Viewer 时间线、Turn / Request Rail | 快速上手、请求与上下文 | 主 GIF、两级导航 GIF |
| Request 详情、History、Context Delta、System diff | 请求与上下文、协议与 Raw | `context-changes.gif` |
| 工具语义与来源关联 | 工具调用与迟到结果 | 主 GIF、`delayed-tool-result.gif` |
| Skill 发现、加载、Harness 注入或通用 Skill 工具 | Skill 章节、支持的 Harness、协议与 Raw | Claude Code Skill 真实 CLI Source 与双尺寸审阅帧 |
| 子 Agent 归因与多 Agent 看板 | 子 Agent 章节 | Claude Code 子 Agent 真实 CLI Source 与双尺寸审阅帧 |
| 上下文压缩或多步任务状态 | 请求与上下文、工具调用 | compact / planning 真实 CLI Source 与双尺寸审阅帧 |
| 协议投影、Raw Inspector、搜索或 provenance | 协议与 Raw、自研 Harness | 协议截图与脱敏 JSON |
| 翻译、语言目录与主题 | 请求与上下文、素材说明 | 对应 Harness 主题素材 |
| 隐私、导入导出、清理或卸载 | 安全清理、排障 | manifest 隐私字段与公开前检查 |
| 任一进入中文核心视频的 Viewer 画面或术语 | 视频制作说明、用户手册入口 | 对应合成帧、字幕、旁白与整片中点抽帧 |

功能 Agent 不需要直接重录所有素材，但必须在 PR 或交接中明确“影响 / 不影响”的矩阵行，并提供精确候选 SHA。

## 推荐的主动触发流程

后续接入自动化时使用以下流程：

1. 监听 `origin/main` 新 commit 或已合并 PR 的变更文件；
2. 根据上表映射到受影响章节和场景。仓库内可以直接运行：

   ```bash
   node scripts/documentation-consistency-audit.mjs --base origin/main
   node scripts/documentation-consistency-audit.mjs --base origin/main --json
   ```

   对尚未提交或由其他系统传入的单个路径，也可以重复使用 `--changed-file`：

   ```bash
   node scripts/documentation-consistency-audit.mjs \
     --changed-file src/viewer/raw-inspector-controller.js \
     --changed-file src/viewer/agent-graph-view.js \
     --json
   ```

   无参数运行只执行一致性门禁，不生成影响报告。JSON 中 `working_tree_dirty: true` 表示载荷仍基于未提交工作区，不能当作可复现的共享目标；交接前应提交到独立分支并重新生成；
3. 运行确定性 `--verify` 和现有文档检查；
4. 如果功能路径变化、对应文档/manifest 没有同步，创建一个文档更新任务；
5. 任务必须携带目标 SHA、变更摘要、受影响章节、需要重录的 Source 和隐私限制；
6. 文档 Agent 在该 SHA 上操作真实 Viewer，局部重录和重新验收；
7. 中文事实稳定后再同步英文及其他语言。

主动触发只负责创建明确任务，不能自动把 roadmap 文案发布为当前功能，也不能在没有视觉复核时自动提交新截图。

`.github/pull_request_template.md` 已要求功能贡献者附上这份影响证据，或明确说明为什么 UI 文案、交互、协议事实和公开行为均未变化。它是进入外部自动监听前的人工触发门，不等于 GitHub 已经自动创建文档任务。

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
- 视频素材同时检查 1920×1080 合成帧、整片抽帧、字幕时码、响度和编辑交接清单；
- 运行 `git diff --check`、Markdown 安全、治理、链接与对应轨迹 `--verify`；
- 运行 `node scripts/documentation-consistency-audit.mjs`；功能分支再附上 `--base <目标 SHA> --json` 的影响报告；
- 报告精确验证 SHA 和仍未覆盖的风险。

## 下一步自动化边界

“变更文件 → 影响矩阵 → 带精确 SHA 的 JSON 交接 → PR 人工确认”现在已经可以在仓库内执行。下一阶段可以把这份 JSON 接入受信任的 GitHub 工作流或 Codex 自动化，用来创建或唤醒文档任务。接入前仍要决定任务承载位置、去重规则、失败重试和谁确认真实 UI 录制；当前仓库尚未自动创建外部任务。
