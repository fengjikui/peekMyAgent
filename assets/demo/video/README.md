# peekMyAgent 中文视频初剪

本目录保存可审阅、可继续回编的中文产品演示 v0.1 的轻量交接文件。成片使用公开的确定性 Viewer 素材，不包含真实 Capture、API Key、用户源码或本地隐私路径。

MP4、独立旁白和生成帧默认只在本地生成，不纳入主仓库。公开播放地址通过 `catalog.json` 管理；详细规则见 [`docs/media-publishing.zh-CN.md`](../../../docs/media-publishing.zh-CN.md)。

## 交付文件

| 文件 | 用途 |
| --- | --- |
| `catalog.json` | 视频版本、校验值、产品 commit 与公开 URL 的唯一目录 |
| `pma-core-tour.zh-CN.mp4` | 本地生成且被 Git 忽略的 1920×1080 中文讲解成片 |
| `pma-core-tour.zh-CN.srt` | 独立字幕，可导入或作为 ChatCut、剪映等编辑器的校时参考 |
| `pma-core-tour.zh-CN-voice.m4a` | 本地生成且被 Git 忽略的独立旁白轨，便于替换或重新混音 |
| `pma-core-tour.zh-CN-cover.png` | 1920×1080 封面 |
| `pma-claude-tool-loop.zh-CN.mp4` | 本地生成且被 Git 忽略的“用户—Claude Code—远端模型”独立成片 |
| `pma-claude-tool-loop.zh-CN.srt` | 第一支 Claude Code 机制视频的可编辑中文字幕 |
| `pma-claude-tool-loop.zh-CN-voice.m4a` | 本地生成且被 Git 忽略的占位旁白轨 |
| `pma-claude-tool-loop.zh-CN-cover.png` | 第一支 Claude Code 机制视频封面 |
| `../source/claude-tool-loop/narration.zh-CN.md` | 按镜头和时码组织的中文旁白审阅稿，也是后续多语言翻译底稿 |

中性的逐镜头记录保存在 `../source/video/timeline.zh-CN.json`。它不是任何剪辑器的原生工程格式，而是为了以后重剪时保留镜头顺序、时码、旁白、字幕和素材来源。

## 重生成

macOS 上安装 ffmpeg，并运行：

```bash
python3 scripts/build-demo-video.py
```

默认使用系统自带的 `Tingting` 中文语音。也可以更换系统 voice 与语速：

```bash
python3 scripts/build-demo-video.py --voice Tingting --rate 175
```

不生成旁白、只保留相同时长的静音版本：

```bash
python3 scripts/build-demo-video.py --no-voice
```

生成第一支 Claude Code 工具调用视频：

```bash
python3 scripts/build-claude-tool-loop-video.py --voice Tingting --rate 175
```

只重建标注图、封面和合成帧，供逐帧审阅：

```bash
python3 scripts/build-claude-tool-loop-video.py --prepare-only
```

对应的 Source、视口、镜头来源、脱敏边界与 QA 记录见 `../source/claude-tool-loop/manifest.json`。本地 v0.1 约 4 分 03 秒，使用 2048×1056 Claude 主题 Viewer 实页素材；MP4 是不带底部说明黑框、不烧录字幕、也不内嵌字幕轨的干净母版，独立 SRT 留给剪映或其他编辑器。MP4 和 M4A 不进入主仓库。

生成完成不代表可以公开发布。完成逐帧和隐私验收后，把 MP4 上传到 GitHub Release 或对象存储，再更新 `catalog.json`；不要直接 `git add -f`。

## 交给 ChatCut 或剪映继续精修

1. 导入 MP4 作为已经校时的粗剪基线；
2. 导入或参考独立 M4A 和 SRT；
3. 需要更自然的配音时替换 M4A，不改动场景时码；
4. 只在章节切换处增加少量 MG 动画，不给 Viewer 正文叠加花哨效果；
5. 导出前再次检查字幕、公开范围和 1920×1080 下的 UI 可读性。

不同编辑器和版本的 SRT 导入能力可能变化，应在当前版本实际确认。系统语音只作为内部初剪占位；公开发布前需要确认目标渠道的语音使用条款，或换成已获授权的配音。
