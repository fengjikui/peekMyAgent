# 中文产品演示视频制作说明

本文记录 peekMyAgent 中文产品演示 v0.1 的工具选择、镜头脚本、编辑交接和验收结果。成片仍是供产品所有者审阅的初剪，不等于最终宣传片。

面向 Claude Code 机制的五支独立视频脚本见[用 PMA 看懂 Claude Code：中文视频系列脚本](video-series-claude-code.zh-CN.md)。

## 第一支独立机制视频：本地 v0.1

“用户—Claude Code—远端模型”的工具调用视频已经生成本地初剪：

```bash
python3 scripts/build-claude-tool-loop-video.py --voice Tingting --rate 175
```

它使用 2048×1056 Claude 主题的真实 Viewer 操作帧，演示一个不需要项目背景的最小任务：读取 `README.md` 第一行并回答项目名。内容依次覆盖完整时间线、Metadata、System、Tools、`tool_use`、`tool_result`、来源跳转、Anthropic Messages、Raw Inspector 和最终 Response。

成片约 4 分 03 秒，1920×1080、30 fps；协议和 Raw 镜头分别保留约 22 秒和 21 秒。MP4 与独立旁白轨只在本地生成并被 Git 忽略，字幕、封面、可重建时间线和 manifest 留在仓库。详细来源和 QA 结果见 `assets/demo/source/claude-tool-loop/manifest.json`。

当前旁白使用 macOS `Tingting` 系统语音，只用于内容和节奏审阅。正式公开前仍需所有者确认文案，再替换为已授权的真人或合成配音。

## 为什么没有把 GIF 简单连起来

文档 GIF 只回答一个局部问题，缺少完整叙事、旁白、字幕和章节过渡。视频需要先说明“普通日志为什么不够”，再依次证明请求上下文、工具证据、原生协议、上下文变化和子 Agent 的价值。

本版因此复用经过视觉验收的真实 Viewer 帧，但重新设计了 11 个镜头、中文旁白、底部字幕、章节标题、封面和编辑器交接文件。

## 工具调研结论

### ChatCut

ChatCut 官方将其定位为基于自然语言的视频编辑 Agent，支持粗剪、转录式编辑、字幕、MG 动画、旁白和音乐。官方同时说明当前素材理解以转录为主，最适合 talking-head 和访谈；可视分析仍在后续范围。[ChatCut 产品说明](https://chatcut.io/docs/what-is-chatcut)

这很适合将来有真人讲解、屏幕录制和多次口播 take 时自动选段。本轮主要输入却是确定性 Viewer 静态帧，最关键的要求是界面不得被裁错、镜头必须足够慢，并且以后可以用同一脚本重建。因此 v0.1 先使用本地确定性时间线完成粗剪，再把 MP4、M4A、SRT、封面和中性 JSON 时间线交给 ChatCut 做第二遍创意编辑。

ChatCut 网页编辑器已经可以打开，但当前工作环境停在账户认证入口，本轮没有假装已经创建其原生工程。官方也提供 Codex 插件安装与 OAuth 说明；接入后仍需要在新的编辑任务中使用。[ChatCut Codex 插件说明](https://chatcut.io/chatgpt-plugin)

### 剪映 / CapCut

CapCut Desktop 和 Web 当前都提供自动字幕、字幕校正和时间线编辑；官方建议生成后人工复核文本、时码与样式。[CapCut 自动字幕说明](https://www.capcut.com/help/how-to-recognise-subtitles)

它适合产品所有者最后调整字体、转场和配音。本仓库不保存剪映专有工程，避免项目格式变化后无法重建；独立 SRT 和 M4A 是交接边界。

### 本轮为什么使用 FFmpeg

- 不需要上传 Viewer 素材或登录第三方服务；
- 每个镜头时长、分辨率、字幕和音量都能确定性验证；
- 可以在 UI 更新后只替换对应合成帧；
- 输出仍可继续导入 ChatCut、剪映、Final Cut 或其他非线性编辑器。

## 完整镜头脚本

| 镜头 | 画面 | 要证明的价值 | 最短停留 |
| --- | --- | --- | --- |
| 0 | 深色标题卡 | 普通日志无法回答模型实际收到什么 | 8 秒 |
| 1 | 完整执行链 | 用户请求、模型请求、工具与回答属于一条证据链 | 14 秒 |
| 2 | System | 能核对模型实际收到的固定指令 | 11 秒 |
| 3 | 工具结果 | 能看到工具真正回传的内容 | 12 秒 |
| 4 | 来源跳转 | 结果可以追溯到原始调用和参数 | 11 秒 |
| 5 | 最终回答 | 能判断回答是否基于工具证据 | 11 秒 |
| 6 | 协议视图 | 摘要之外仍保留厂商原生上下行 | 15 秒 |
| 7 | System diff | 能比较相邻请求的固定上下文变化 | 13 秒 |
| 8 | 迟到工具结果 | 跨多次请求仍能定位来源调用 | 13 秒 |
| 9 | 多 Agent 看板 | 能展开父级、子分支、工具与回流 | 14 秒 |
| 10 | 深色结束卡 | 引导从非敏感五分钟快速上手开始 | 9 秒 |

实际成片约 2 分 24 秒。旁白较长的镜头会自动延长，不会压缩到低于表中时长。

## 生成与交接

```bash
python3 scripts/build-demo-video.py
```

主要输出：

- `assets/demo/video/pma-core-tour.zh-CN.mp4`；
- `assets/demo/video/pma-core-tour.zh-CN.srt`；
- `assets/demo/video/pma-core-tour.zh-CN-voice.m4a`；
- `assets/demo/video/pma-core-tour.zh-CN-cover.png`；
- `assets/demo/source/video/timeline.zh-CN.json`；
- `assets/demo/source/video/frames/*.png`。

其中 MP4、M4A 和合成帧是可重复生成的大体积结果，默认被 Git 忽略；主仓库只保留脚本、时间线、字幕、封面、manifest 与发布 catalog。成片通过 GitHub Releases 或对象存储分发，规则见[演示视频的存储与发布策略](media-publishing.zh-CN.md)。

`timeline.zh-CN.json` 不是 ChatCut 或剪映的原生工程文件。它是稳定的镜头交接记录，让人工编辑可以按照精确时码重建，而不必从成片倒推镜头。

## 本轮验收

- 1920×1080、30 fps、H.264；
- 11 个 UI / 标题镜头，所有 UI 镜头至少停留 11 秒；
- AAC 双声道旁白，整片约 -16 LUFS，峰值低于 0 dBFS；
- MP4 内含简体中文 `mov_text` 字幕轨，同时提供独立 SRT；
- 对 11 张完整合成帧、整片中点抽帧和封面执行视觉检查；
- 标题、编号与字幕居中，字幕没有遮挡当前箭头目标或关键结果；
- 没有音乐，避免引入不明确版权；
- 系统 TTS 仅作为内部审阅占位，公开发布前确认使用条款或换成已授权配音。

## 下一轮更适合交给 ChatCut 的工作

当已有登录状态或真人口播素材后：

1. 用本版 MP4 作为结构参考；
2. 导入真人口播或已授权旁白，按转录文本删除重复 take；
3. 只在五个章节切换处增加简洁 MG 标题；
4. 不自动裁剪 Viewer 三栏布局；
5. 逐段复核自动字幕，特别是 PMA、Harness、System、Raw、OpenAI 与 Anthropic；
6. 保留无音乐版本，再单独评估有授权背景音乐的版本。
