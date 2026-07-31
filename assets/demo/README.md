# Demo Media Assets

这个目录保存 README 和用户手册使用的公开演示素材。中文快速上手 v0.1 使用真实 PMA Viewer、确定性假上游和完全虚构的数据生成。

## 当前主素材

- `quickstart-tool-loop.gif`：从用户请求到工具闭环、最终回答和原始协议的慢速主 GIF，42.7 秒。
- `quickstart-overview.png`：1536×792 无标注总览。
- `quickstart-overview-annotated.png`：带一个注意力标注的首帧。
- `quickstart/01-trace.png` ～ `quickstart/06-protocol.png`：六张章节标注图。
- `source/quickstart/*-raw.png`：六张未标注的真实 Viewer 原始帧。
- `source/quickstart/manifest.json`：源提交、场景、视口、主题、隐私检查、帧时长和重生成命令。

旧版 `dashboard-overview*`、`chat-upstream-context*` 和 `tool-call-loop*` 暂时保留，方便比较界面变化；当前中文版 README 不再引用它们。

## 重现

先启动确定性本地演示：

```bash
node scripts/readme-media-demo.mjs --port 43112
```

在 `http://127.0.0.1:43112` 中操作真实 Viewer，并按 `source/quickstart/manifest.json` 记录的状态采集 1536×792 原始帧。随后运行：

```bash
python3 scripts/build-readme-media.py
```

脚本会重新生成所有 `quickstart-*` 发布素材。完整镜头脚本见 `docs/visual-usage-guide.zh-CN.md`。

## 制作规则

- 只使用非敏感、可重现的 demo 会话。
- Codex 场景使用 Codex 主题；Claude Code 场景使用 Claude 主题。
- 保留全屏桌面信息密度；当前基准视口为 1536×792。
- 一帧只传达一个重点，普通阅读画面至少 2.5～4 秒；本主 GIF 为提高可读性使用 5.2～9.5 秒。
- 红框、箭头和短文字不能遮挡关键字段。
- 尽量将 GIF 控制在 8 MiB 内；当前主 GIF 小于 1 MiB。
- 保存原始帧、标注图、manifest 和生成脚本，以便 UI 更新后局部重录。
- 分享前逐帧检查路径、提示词、源码、工具结果、认证信息和历史消息。
