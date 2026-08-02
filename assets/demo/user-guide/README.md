# 用户手册演示素材

本目录保存快速上手之后的中文版用户手册素材。上下文和迟到结果保留 2048×1056 的确定性真实 Viewer Source，再无裁切地适配为 1024×576 中性画布；子 Agent 复用当前 Claude 章节的 1024×576 审阅帧。全部数据使用本地上游、虚构 `/demo/...` 路径和假凭据。

## 发布素材

| 文件 | 主题 | 时长 | 用途 |
| --- | --- | --- | --- |
| `context-changes.gif` | Codex | 6.5s + 9.5s | 从请求详情进入 System diff |
| `delayed-tool-result.gif` | Codex | 7.5s + 8.5s | 迟到结果与 `来源 #1` |
| `subagent-collaboration.gif` | Claude | 6.5s + 3s + 6.5s | 展开多 Agent 看板并查看完整子分支 |

对应静态标注图也保存在本目录，便于文档在不适合播放 GIF 时引用。

## 重生成

启动确定性轨迹：

```bash
node scripts/user-guide-media-demo.mjs --port 43113
```

脚本会打印上下文、迟到结果和子 Agent 三个 Source URL。需要重录原始 Source 时使用当前 1920×1080 浏览器基线：Codex Source 选择 Codex 主题，Claude Code Source 选择 Claude 主题。现有两张 Codex 历史 Source 仍保持原始 2048×1056，不通过裁切伪装成新录制。

只验证三条轨迹的稳定语义并自动退出：

```bash
node scripts/user-guide-media-demo.mjs --port 43113 --verify
```

采集原始帧后重新生成：

```bash
python3 scripts/build-user-guide-gifs.py
```

该脚本只重建两级导航与三张用户手册 GIF，不会覆盖 README 主 GIF。每一帧必须执行 `docs/visual-usage-guide.zh-CN.md#逐帧视觉验收门禁`，并以 1024×576 原尺寸检查编号居中、聚焦范围、字幕安全区和画面完整性。生成脚本成功不等于视觉验收通过。

## 隐私

完整场景、Source、帧时长和脱敏说明见 `assets/demo/source/user-guide/manifest.json`。任何新的公开画面都必须重新检查 System、History、Tools、Raw、路径、命令输出和子 Agent prompt。
