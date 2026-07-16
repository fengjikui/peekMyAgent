# Roadmap / 待实现计划

这份 Roadmap 只记录尚未实现、或已经有基础能力但仍需要明显产品化增强的事项。已经成为 peekMyAgent 核心能力的功能，不再作为“待实现”列出，避免误导用户和贡献者。

## 已实现核心能力

这些能力已经进入产品主路径，后续只做体验打磨和边界 case 加固：

- **Trace Viewer**：支持请求时间线、Raw 分段、Messages / System / Tools / Tool use / Tool result / Response / Metadata 查看、分区搜索、Markdown 展示和右侧证据面板。
- **多 Agent 分析**：支持 Claude Code 子 Agent 信息流识别、父子归属、子 Agent 看板、结果回流标识、紧凑摘要和可展开详情。
- **翻译与国际化**：支持界面中英文切换、翻译目标语言选择、System / Tools / Harness / thinking 等块级翻译、翻译缓存、手动刷新与块级重译。
- **Trace 分享**：支持 Trace 导出、导入和静态查看，方便把一次 Agent 调试证据包分享给他人复盘。
- **会话管理**：支持会话隐藏/归档、删除、清理、暂停、恢复、停止和 dashboard 侧发送消息。
- **分块缓存存储**：新捕获的请求默认按 system / tool schema / message / tool result 分块入库，Raw 读取时可从 content blobs 无损重建，并支持 `pma compact` 压缩旧数据。
- **大 Trace cursor 渐进加载**：live/SQLite 会话首屏只读取首批请求，后续按 cursor 合并 request、Turn 和 Agent 实体增量；Raw/detail 按 request 懒加载，不再后台下载整条 compact Trace。

## 当前发布前主线（2026-07-16）

正式录制产品视频并开始宣发前，只保留下面两项主线，其他产品增强不得挤占它们：

1. **npm-first 安装与更新**：把 npm registry 作为公开版本的唯一分发源。首次发布 `peekmyagent` Alpha 后，用户通过 `npm install --global peekmyagent@next` 安装和更新；稳定版发布后使用 `npm install --global peekmyagent`。未来 `pma update` 只能作为这套 npm 更新流程的便捷入口，必须识别安装来源、显示当前/目标版本、运行 `pma doctor` 并提供失败恢复说明，不能维护第二套下载器。
2. **重新设计子 Agent 信息架构**：先回答用户真正需要知道的四件事——为什么启动、当前在做什么、产生了哪些关键动作、结果如何回到主 Agent——再决定视觉形式。默认视图应以任务和 Agent 实例为中心提供可读摘要；时间顺序、模型请求、工具调用、关联 ID 和原始 JSON 作为逐层展开的证据保留。设计必须使用真实的并行、异步回流、长工具链和嵌套边界 Trace 验证，不能只在理想 fixture 上看起来整齐。

两项均完成并经过真实用户路径验证后，再录制正式演示视频、补齐 README 媒体并开始集中宣发。

## 近期发布打磨

- **README 演示媒体**：补充一个短 GIF 或视频，展示真实 Claude Code Trace、Raw 分段、多 Agent 信息流、翻译能力以及 Trace 导出/导入。
- **多语言文档入口**：以英文 README 为功能事实源，保留简体中文，并逐步增加日语、韩语、西班牙语、法语、德语和葡萄牙语短版 README。每个版本都必须包含产品用途、安装、三分钟快速开始、隐私边界和故障排查入口，不能只翻译宣传语。
- **Agent 可读说明**：增加仓库级 `llms.txt` 和稳定的 Agent quickstart，向 Codex、Claude Code、OpenClaw 等自动化读者说明 peekMyAgent 做什么、如何安装/启动/验证、哪些命令会修改本机状态，以及应该从哪些文档读取当前架构与贡献规范。所有语言 README 指向同一份 Agent 入口，避免复制多套会漂移的机器说明。
- **首次使用引导**：当 dashboard 为空时，直接告诉用户如何通过 peekMyAgent 启动 Claude Code 或 OpenClaw，而不是要求先读完整 README。
- **故障排查文档**：整理启动失败、端口占用、provider 配置、Windows 权限、模型不可用等常见问题，给出明确命令和恢复步骤。
- **文案与国际化检查**：每次新增或修改 UI 文案时，同步检查 `zh-CN` 和 `en-US` 的 i18n 字典。
- **公开文档收敛**：继续把历史设计、实验记录和发布策略文档合并成更适合开源读者阅读的结构。

## 体验与边界增强

- **复杂多 Agent 边界加固**：继续验证嵌套子 Agent、长工具链、异步回流、OTel request/response 文件顺序错位等边界 case。
- **Response 证据面板继续打磨**：保持最终解析结果优先展示，同时保留流式原始事件，方便用户同时看“结果”和“原始证据”。
- **Trace 脱敏导出**：导出前支持对 secrets、路径、headers 和选定消息内容做脱敏，便于安全分享。
- **Issue 附件工作流**：用户报告 bug 时，可以方便地附上一份脱敏 Trace 包。
- **回归样例沉淀**：把有代表性的 Trace 转成 replay/eval fixtures，用于覆盖工具失败、上下文压缩、子 Agent 路由和 response 解析回归。

## 捕获与适配器

- **Setup / Profile UI**：提供可视化界面，让用户按 Agent 启用或关闭捕获，并支持 dry-run、备份、恢复和 drift 检测。
- **更安全的全局代理模式**：探索一个显式 opt-in 的模式，临时把某个 Agent 的 provider 配置改到 peekMyAgent 代理上，同时提供隐私提示和恢复控制。
- **更多 Agent 适配器**：在 Claude Code 和 OpenClaw 打磨稳定后，再继续接入 OpenCode、Hermes、Cursor、Gemini CLI、Aider 等 coding agent。
- **Provider 兼容性提示**：区分 model-not-found、thinking/reasoning 参数冲突、upstream auth 失败、本地代理失败等错误类型。
- **终端代理模式**：调研 `pma claude` 是否应持有 Claude Code 的 PTY，让 dashboard 发送的消息也能出现在原终端中。

## 分发

- **跨平台安装器**：继续打磨 macOS、Linux、Windows 上的 install、doctor、uninstall 和 state path 行为。
- **可审计的便捷更新**：以 npm 为唯一公开版本源，提供 `pma update --check` 与 `pma update` 作为 npm 安装用户的便捷入口。更新必须显示当前/目标版本、来源和计划，复用安装器的跨平台 prefix/权限处理，更新后运行 `pma doctor`，失败时保留旧版本或给出明确恢复命令。源码工作区不得在脏树上自动 `git pull`，也不得默认执行未经版本标记的远程脚本。未来 dashboard 更新入口只能调用同一 update service，不能维护第二套更新逻辑。
- **发布通道与频率**：日常 `main` 推送不等于要求所有用户当天升级。先建立 `stable` 版本和可选 `edge` 通道；安全修复可明确提示升级，普通重构按批次发布，避免频繁更新打断用户。
- **Homebrew 或包管理器分发**：源码安装路径稳定后，再考虑 Homebrew 等分发方式。
- **签名二进制或应用包**：当用户群超出 CLI-first 开发者后，再评估签名包、桌面应用和自动更新。
- **卸载可信度**：让 `pma uninstall --remove-data` 和未来 UI 卸载路径可预测、可审计、足够保守。
