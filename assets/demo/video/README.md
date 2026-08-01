# peekMyAgent 中文视频初剪

本目录保存可审阅、可继续回编的中文产品演示 v0.1。成片使用公开的确定性 Viewer 素材，不包含真实 Capture、API Key、用户源码或本地隐私路径。

## 交付文件

| 文件 | 用途 |
| --- | --- |
| `pma-core-tour.zh-CN.mp4` | 1920×1080 中文讲解成片，包含 AAC 旁白和可开关的简体中文字幕轨 |
| `pma-core-tour.zh-CN.srt` | 独立字幕，可导入或作为 ChatCut、剪映等编辑器的校时参考 |
| `pma-core-tour.zh-CN-voice.m4a` | 归一化到约 -16 LUFS 的独立旁白轨，便于替换或重新混音 |
| `pma-core-tour.zh-CN-cover.png` | 1920×1080 封面 |

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

## 交给 ChatCut 或剪映继续精修

1. 导入 MP4 作为已经校时的粗剪基线；
2. 导入或参考独立 M4A 和 SRT；
3. 需要更自然的配音时替换 M4A，不改动场景时码；
4. 只在章节切换处增加少量 MG 动画，不给 Viewer 正文叠加花哨效果；
5. 导出前再次检查字幕、公开范围和 1920×1080 下的 UI 可读性。

不同编辑器和版本的 SRT 导入能力可能变化，应在当前版本实际确认。系统语音只作为内部初剪占位；公开发布前需要确认目标渠道的语音使用条款，或换成已获授权的配音。
