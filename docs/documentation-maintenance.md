# 用户文档与演示素材持续更新机制

本文定义功能 Agent 与文档 Agent 之间的长期协作方式。它区分当前已经具备的检查基础与尚未接入的主动触发计划，不能把计划写成已运行的自动化。

## 当前已经具备

- `origin/main` 和精确 commit SHA 是功能事实来源；
- `docs/user-guide.md` 是任务式用户手册入口；
- `scripts/readme-media-demo.mjs` 可重建快速上手轨迹；
- `scripts/user-guide-media-demo.mjs --verify` 可重建并断言上下文、迟到结果和子 Agent 三条轨迹；
- `scripts/claude-mechanisms-media-demo.mjs --verify` 可重建并断言 Claude 工具闭环、Skill、五 Request 规划和 compact 分类合约；
- `scripts/build-readme-media.py` 可从保留的原始帧重新生成标注图和慢速 GIF；
- `scripts/build-demo-video.py` 可从已验收素材重新生成中文 MP4、旁白、字幕、封面与中性时间线；
- `docs/media-publishing.zh-CN.md` 规定主仓库只跟踪轻量、可复现的制作资料，成片通过 Releases 或对象存储发布；
- `docs/video-series-claude-code.zh-CN.md` 保存工具闭环、Skill、子 Agent、上下文压缩和多步规划五支独立视频的事实边界与逐镜头脚本；
- `docs/visual-usage-guide.zh-CN.md` 定义逐帧视觉验收门禁；
- `assets/demo/source/*/manifest.json` 记录视口、主题、协议、帧时长、隐私和预期语义。

这些能力可以发现确定性轨迹或素材生成失败，但还没有自动监听 `origin/main` 并创建文档任务。

## 功能到文档的影响矩阵

| 功能变更边界 | 必查文档 | 必查演示 |
| --- | --- | --- |
| `bin/`、安装、CLI help、wrapper 生命周期 | README、快速上手、观察会话、支持的 Harness、安全清理、排障 | 启动命令素材与 `smoke:cli` |
| Viewer 时间线、Turn / Request Rail | 快速上手、请求与上下文 | 主 GIF、两级导航 GIF |
| Request 详情、History、Context Delta、System diff | 请求与上下文、协议与 Raw | `context-changes.gif` |
| 工具语义与来源关联 | 工具调用与迟到结果 | 主 GIF、`delayed-tool-result.gif` |
| 子 Agent 归因与多 Agent 看板 | 子 Agent 章节 | `subagent-collaboration.gif` |
| 协议投影、Raw Inspector、搜索或 provenance | 协议与 Raw、自研 Harness | 协议截图与脱敏 JSON |
| 翻译、语言目录与主题 | 请求与上下文、素材说明 | 对应 Harness 主题素材 |
| 隐私、导入导出、清理或卸载 | 安全清理、排障 | manifest 隐私字段与公开前检查 |
| 任一进入中文核心视频的 Viewer 画面或术语 | 视频制作说明、用户手册入口 | 对应合成帧、字幕、旁白与整片中点抽帧 |

功能 Agent 不需要直接重录所有素材，但必须在 PR 或交接中明确“影响 / 不影响”的矩阵行，并提供精确候选 SHA。

## 推荐的主动触发流程

后续接入自动化时使用以下流程：

1. 监听 `origin/main` 新 commit 或已合并 PR 的变更文件；
2. 根据上表映射到受影响章节和场景；
3. 运行确定性 `--verify` 和现有文档检查；
4. 如果功能路径变化、对应文档/manifest 没有同步，创建一个文档更新任务；
5. 任务必须携带目标 SHA、变更摘要、受影响章节、需要重录的 Source 和隐私限制；
6. 文档 Agent 在该 SHA 上操作真实 Viewer，局部重录和重新验收；
7. 中文事实稳定后再同步英文及其他语言。

主动触发只负责创建明确任务，不能自动把 roadmap 文案发布为当前功能，也不能在没有视觉复核时自动提交新截图。

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
- 报告精确验证 SHA 和仍未覆盖的风险。

## 下一步自动化边界

下一阶段可以把“变更文件 → 影响矩阵 → 创建文档任务”接入受信任的 GitHub 工作流或 Codex 自动化。接入前要先决定任务承载位置、去重规则和谁确认真实 UI 录制；当前仓库尚未启用这一步。
