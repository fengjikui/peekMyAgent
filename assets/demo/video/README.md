# peekMyAgent 中文视频初剪

本目录保存可审阅、可继续回编的中文产品演示 v0.1 的轻量交接文件。成片使用公开的确定性 Viewer 素材，不包含真实 Capture、API Key、用户源码或本地隐私路径。

MP4、独立旁白和生成帧默认只在本地生成，不纳入主仓库。旁白可能由剪映导出为 M4A、MP3 或临时 WAV；这些文件同样不进入 Git。公开播放地址通过 `catalog.json` 管理；详细规则见 [`docs/media-publishing.zh-CN.md`](../../../docs/media-publishing.zh-CN.md)。

## 交付文件

| 文件 | 用途 |
| --- | --- |
| `catalog.json` | 视频版本、校验值、产品 commit 与公开 URL 的唯一目录 |
| `pma-core-tour.zh-CN.mp4` | 本地生成且被 Git 忽略的 1920×1080 中文讲解成片 |
| `pma-core-tour.zh-CN.srt` | 独立字幕，可导入或作为 ChatCut、剪映等编辑器的校时参考 |
| `pma-core-tour.zh-CN-voice.m4a` | 本地生成且被 Git 忽略的独立旁白轨，便于替换或重新混音 |
| `pma-core-tour.zh-CN-cover.png` | 1920×1080 封面 |
| `pma-quickstart.zh-CN.srt` | 五分钟快速上手 v0.2 的 48 条可编辑中文字幕 |
| `../source/quickstart/narration.zh-CN.md` | 五分钟快速上手 v0.2 的教学合同与中文旁白母稿 |
| `pma-claude-tool-loop.zh-CN.mp4` | 本地生成且被 Git 忽略的“用户—Claude Code—远端模型”独立成片 |
| `pma-claude-tool-loop.zh-CN.srt` | 第一支 Claude Code 机制视频 v0.2 的 51 条可编辑中文字幕 |
| `pma-claude-tool-loop.zh-CN-voice.srt` | 为剪映文本朗读优化发音的中文字幕，不直接作为发布字幕 |
| `pma-claude-tool-loop.zh-CN-voice.m4a` | 本地生成且被 Git 忽略的占位旁白轨 |
| `pma-claude-tool-loop-zh-CN-<音色>.mp3` | 产品所有者在剪映中生成的本地授权配音，不进入 Git |
| `pma-claude-tool-loop.zh-CN-<音色>-subtitled-preview.mp4` | 将干净画面、授权配音与短句字幕合成的本地审阅版 |
| `pma-claude-tool-loop.zh-CN-cover.png` | 第一支 Claude Code 机制视频封面 |
| `../source/claude-tool-loop/narration.zh-CN.md` | 按镜头和时码组织的中文旁白审阅稿，也是后续多语言翻译底稿 |
| `pma-claude-skill.zh-CN.srt` | “Skill 怎样被发现和加载”的逐句中文字幕 |
| `../source/claude-skill/narration.zh-CN.md` | Skill 章节的中文事实与旁白母稿 |
| `pma-claude-subagents.zh-CN.srt` | “子 Agent 在哪里运行，结果怎样回来”的逐句中文字幕 |
| `../source/claude-subagents/narration.zh-CN.md` | 子 Agent 章节的中文事实与旁白母稿 |
| `pma-claude-compact.zh-CN.srt` | “上下文压缩究竟改变了什么”的逐句中文字幕 |
| `../source/claude-compact/narration.zh-CN.md` | 上下文压缩章节的中文事实与旁白母稿 |
| `pma-claude-planning.zh-CN.srt` | “一个用户请求为什么会变成七次模型往返”的逐句中文字幕 |
| `../source/claude-planning/narration.zh-CN.md` | 多步任务章节的中文事实与旁白母稿 |

每章的中性逐镜头记录保存在对应 Source 下的 `video/timeline.zh-CN.json`。它不是任何剪辑器的原生工程格式，而是为了以后重剪时保留镜头顺序、时码、旁白、字幕和素材来源。

从时间线重新生成某一章的 SRT：

```bash
node scripts/timeline-subtitles-to-srt.mjs \
  assets/demo/source/claude-planning/video/timeline.zh-CN.json \
  assets/demo/video/pma-claude-planning.zh-CN.srt
```

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

生成可横向比较的 MiMo 中文女声试听片段：

```bash
python3 scripts/generate-mimo-tts.py \
  --auditions assets/demo/source/claude-tool-loop/voice-auditions.zh-CN.json
```

脚本默认读取被 Git 忽略的 `.env.mimo.local`；也可以用 `--env-file` 指向其他本地凭证文件。试听 WAV 只写入被 Git 忽略的 `tmp/mimo-tts-samples/`。仓库保存的是不含凭证的音色配方，而不是 API Key 或生成音频。

旧版脚本仍可重建 v0.1 本地初剪：

```bash
python3 scripts/build-claude-tool-loop-video.py --voice Tingting --rate 175
```

只重建 v0.1 烧录标注图、封面和合成帧：

```bash
python3 scripts/build-claude-tool-loop-video.py --prepare-only
```

这两个 Python 命令不渲染当前 v0.2 网页时间线，只用于比较或回看旧母版。当前工具调用章节以 `../source/claude-tool-loop/video/timeline.zh-CN.json` 和 `../storyboard/index.html` 为准：约 4 分 05 秒、51 条字幕、36 个渐进审阅点，并已在 1920×1080 与 1024×576 下逐帧复核。Source 类型、真实 CLI 交叉核对边界、素材和 QA 记录见 `../source/claude-tool-loop/manifest.json`。MP4、M4A、MP3 和 WAV 不进入主仓库。

生成完成不代表可以公开发布。完成逐帧和隐私验收后，把 MP4 上传到 GitHub Release 或对象存储，再更新 `catalog.json`；不要直接 `git add -f`。

## 交给 ChatCut 或剪映继续精修

1. 导入 MP4 作为已经校时的粗剪基线；
2. 导入或参考独立 M4A 和 SRT；
3. 需要更自然的配音时把 `-voice.srt` 导入剪映，替换 M4A/MP3 时不改动场景时码；
4. 只在章节切换处增加少量 MG 动画，不给 Viewer 正文叠加花哨效果；
5. 导出前再次检查字幕、公开范围和 1920×1080 下的 UI 可读性。

不同编辑器和版本的 SRT 导入能力可能变化，应在当前版本实际确认。系统语音只作为内部初剪占位；公开发布前需要确认目标渠道的语音使用条款，或换成已获授权的配音。
