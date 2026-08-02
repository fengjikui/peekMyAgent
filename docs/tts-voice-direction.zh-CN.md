# 中文产品视频的 TTS 音色与声音导演规范

本文记录 PMA 中文产品视频旁白的试听方法、MiMo 提示结构、剪映参考结论和长期自动化边界。它服务于演示素材生产，不属于 PMA 运行时能力说明。

> 当前状态（2026-08-01）：已有 MiMo 预置音色、导演模式和 Voice Design 样本均未入选。后续音色探索已拆分到[中文主讲人音色探索交接](tts-voice-tuning-handoff.zh-CN.md)，每轮最多三条并等待所有者反馈；视频文档任务暂不继续批量生成 TTS。

## 目标不是“清楚地念完”

PMA 视频同时需要两种声音状态：

1. 前 8～15 秒承担宣传钩子，要有好奇、发现和记忆点；
2. 后续机制讲解承担可信度和耐听度，要清楚、自然、不过度表演。

不能用一条“稍慢、克制、不夸张”的导演词覆盖整片。它适合教程正文，却会压低开场吸引力。也不能让四分钟始终保持预告片强度，否则容易疲劳。正式 voice profile 应固定同一个说话人身份，并至少保存 `hook`、`explain` 和 `conclusion` 三种表演预设。

## 已验证的剪映参考

本机剪映工程中的“台湾甜妹”旁白由多条字幕分别生成：时间线上约 52 个文本片段各自对应一个音频片段，而不是一次生成完整四分钟音轨。这说明该参考成片中的停顿同时来自音色、字幕断句和片段间隔，但它只反映剪映当前工程的生产方式，不等于 MiMo 的推荐调用方式。

截取与第一轮 MiMo 完全同文案的前 16.712 秒后，得到以下客观特征。它们只能描述声学表现，不能替代人类对“是否好听”的判断。

| 样本 | 中位基频 | 音高 10%～90% 范围 | 响度 10%～90% 范围 | 有声占比 | 180ms 以上停顿 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 剪映“台湾甜妹”参考 | 约 231 Hz | 约 9.5 半音 | 约 19.1 dB | 59.0% | 6 次，共约 4.17 秒 |
| MiMo 第一轮范围 | 约 202～216 Hz | 约 8.5～13.8 半音 | 约 15.6～17.7 dB | 66.8%～75.2% | 7～8 次，共约 3.16～4.68 秒 |

参考音频更明亮、轻重层次更大，同时保留更多空白。需要学习的是“明亮声线 + 动态对比 + 片段留白”，而不是简单提高全局语速。

剪映/CapCut 的公开帮助只描述添加文本、选择语言和内置音色、生成并试听的使用流程，没有公开“台湾甜妹”的模型、训练方法或可复制提示词。[CapCut 文本朗读帮助](https://www.capcut.com/help/text-to-speech-feature)

## MiMo 的两层控制必须分开

### 第一层：音色身份

Voice Design 只负责回答“这个人长期听起来是谁”。按照 MiMo 官方 Skill 的建议，描述控制在一到两句话，不写当前场景、镜头动作或本次台词。至少包含：

- 年龄段、性别和语言区域；
- 气息走向、共鸣位置、吐字和音色底色；
- 默认节奏；
- 默认情绪；
- 最多一个有辨识度的说话习惯。

示例：

> 二十五岁女性，普通话自然，中高音区，口腔前置共鸣形成清亮、轻盈但饱满的声线，气息轻而核心稳定，吐字干净。节奏有短促推进和清晰停顿，情绪底色是聪明、真实好奇与亲和自信，关键字由轻到实，字尾收束利落。

MiMo TTS 具有随机性，同一个描述要生成多条候选。选中满意的 Voice Design 样本后，应保存原始 WAV，并用 MiMo 自己生成的这条样本进入 Voice Clone，形成后续视频可复用的说话人身份。不要每个段落重新运行 Voice Design。

不得把剪映、其他平台的商业预置音色或未获授权真人录音直接用于声音克隆。剪映参考只用于比较节奏、明暗和动态；声音克隆只使用权利清晰的自有录音或 MiMo 自己生成并获选的设计样本。

### 第二层：章节表演

Voice Clone 或预置音色的 `user` 消息使用导演模式，回答“这个固定说话人在当前章节怎样讲”。一个章节可以覆盖多个连续镜头，只要角色、语气和讲解目的没有改变：

```text
角色：固定的产品主讲人身份和面对的观众。
场景：这一章节正在提出疑问、揭示证据，还是解释机制。
指导：
- 语速与顿挫；
- 气息、共鸣与轻重；
- 需要重读的 1～3 个词；
- 这一镜头的情绪起点、转折和收束。
```

每个章节只改变必要维度。不要同时堆叠“清亮、空灵、磁性、甜美、高冷、活泼、严肃”等互相竞争的标签。只有章节中的某一句确实需要局部变化时，才使用稀疏标签或标点控制；不要为了镜头切换而重置一次 TTS 调用。

## 台词本身也是声音控制器

MiMo 的目标文本必须放在 `assistant` 消息；`user` 消息用于自然语言导演。预置音色和 Voice Clone 支持音频标签，Voice Design 暂不支持句内标签。[MiMo-V2.5-TTS 官方文档](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5)

台词遵循以下规则：

- 一次生成 2～5 句，让模型有足够上下文建立节奏；
- 一句话最多一个标签，标签是调味，不是主内容；
- 逗号用于意群，句号用于完整收束，省略号用于可感停顿，破折号用于拖音或突然转折；
- 技术缩写在配音文本中改写为可朗读形式，例如 `P M A`、`README 点 m d`；显示字幕仍保留标准拼写；
- 前三秒优先使用短问题、反差或结论，不从“这支视频将介绍”开始；
- 不依靠连续感叹号、全大写或大量 `[强调]` 制造虚假的宣传感。

MiMo 官方开源 Skill 进一步建议：音色描述保持凝练，目标文本使用 2～5 句，标点承担表演意义，并可采用“Voice Design 选样 → Voice Clone 固定”的工作流。[XiaomiMiMo/MiMo-Skills](https://github.com/XiaomiMiMo/MiMo-Skills/tree/main/skills/mimo-v2-5-tts)

### 中英混合术语使用双稿

MiMo 当前官方文档和 Skill 没有提供发音词典、音素或 SSML 发音覆盖。正式生产因此必须同时保存两份文字：

- `display text`：用户在画面上看到的标准产品名、协议名和代码，例如 `Claude Code`、`PMA`、`tool_use`；
- `speech text`：只提供给 TTS 的可朗读文本，允许写成 `克劳德 Code`、`P M A`、`tool use`。

朗读稿改写不能凭感觉直接进入正片。每个关键术语至少做“原始拼写 / 加气口 / 中文音译”三种同导演词 A/B，先用 ASR 检查可辨识度，再由产品所有者试听自然度。屏幕字幕、README 和产品文案永远保留标准拼写。

2026-08-01 的“茉莉｜稳定产品主讲人”短测使用相同内容和相同导演词，仅改变 `Claude Code` 的朗读写法。样本约 9.44～10.56 秒；MiMo ASR 的回听结果如下。ASR 只能验证“容易被识别成什么”，不能评价音色是否好听。

| 朗读稿写法 | ASR 对术语的回听 | 结论 |
| --- | --- | --- |
| `Claude Code` | `call code` | 原始拼写不够稳定 |
| `Claude，Code` | `Claude Code` | 术语清楚，但本次把后面的 `PMA` 听错 |
| `克劳德 Code` | `克劳德 Code` | 本轮辨识最稳定，优先进入主观试听 |
| `克劳德，Code` | `Cloud Code` | 气口没有带来额外收益 |

可重建配方见 `assets/demo/source/claude-tool-loop/voice-auditions-moli-presenter.zh-CN.json`。

其他成熟 TTS 的一手文档也支持相同原则：声音选择通常比模型细项更重要，预览文本要与目标角色一致并提供足够上下文；自然语言、标点和文本结构会显著影响情绪与节奏。[ElevenLabs Voice Design](https://elevenlabs.io/docs/eleven-creative/voices/voice-design/)、[ElevenLabs TTS 提示实践](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices)

SSML 厂商把停顿、重音、语速和音高作为独立控制项。MiMo 不直接使用这些 SSML 标签，但我们应把同样的概念翻译成导演词、标点和稀疏音频标签，而不是用一个“有感情地朗读”概括全部要求。[Google Cloud SSML](https://docs.cloud.google.com/text-to-speech/docs/ssml)、[Azure Speech SSML](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-voice)

## 试听与验收协议

每轮只比较一个变量，并保留一个已知参考：

1. 同文案比较说话人身份；
2. 同说话人比较 `hook` / `explain` 表演；
3. 同表演比较标点和标签；
4. 每条生成至少两个 take，避免把随机结果误认为稳定能力；
5. 试听时响度归一，但同时保留未经处理的原始 WAV；
6. 先听前 3 秒，再听完整 15～20 秒，最后评估连续 60 秒是否疲劳；
7. 单独核对 Claude Code、Agent、PMA、Raw、tool use、tool result 等中英混合术语；
8. 记录“喜欢什么”和“哪里出戏”的具体时码，不只记录总分。

当前 Codex 任务不支持原生音频输入，因此不能把它的主观听感当作验收。MiMo-V2.5 音频理解可以用于转写、损坏检测和辅助评分，但测试中出现过把文案悬念误判为音色抓力的情况，必须检查隐藏推理并与同文案盲测、声学指标和产品所有者试听交叉验证。[MiMo 音频理解文档](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/multimodal-understanding/audio-understanding)

最终决定权属于产品所有者的实际试听。自动指标和音频模型只能帮助缩小候选，不能替代审美。

## 长旁白生成与校时

MiMo 官方 Skill 明确建议几乎所有长文本都一次生成，只在超过 2500 个汉字时才按自然句或段落拆分。这条规则优先于从剪映时间线观察到的“逐字幕生成”做法。[MiMo V2.5 TTS Skill：长文本处理](https://github.com/XiaomiMiMo/MiMo-Skills/blob/main/skills/mimo-v2-5-tts/SKILL.md#长文本处理)

PMA 视频采用以下顺序：

1. 冻结一章完整的显示稿和朗读稿；
2. 用固定 voice profile 与该章导演词一次生成完整旁白，通常不是逐字幕调用；
3. 保存原始 WAV、请求配方和服务版本，再检查术语转写、破音、漏字及异常停顿；
4. 根据真实音频做句级对齐，生成短句显示 SRT，并反推 HTML 镜头和标注时码；
5. 若一句不合格，优先重生成所在章节；只有供应商限制或超过 2500 字时才自然分段后拼接。

这样可以避免 52 次独立调用带来的音色、情绪和语速重置，同时仍让最终字幕保持电视剧式的一次一句。字幕分段是显示层，TTS 调用分段是声音层，两者不应绑定。

## 多语言策略

多语言版本共享角色定位和情绪曲线，但不强求同一个物理音色跨语言模仿。每种语言优先选择母语或对应地区音色，分别做发音词典和试听：

- 中文先完成 voice profile 与三种表演预设；
- 英文分别试听 Mia、Chloe 和原生英文 Voice Design；
- 其他语言在官方能力和实际发音通过测试后再纳入，不从中文样本推断；
- UI 画面可以复用时，配音与字幕仍按目标语言重新断句和校时。

## 当前可重建素材

- 教程式同文案第一轮：`assets/demo/source/claude-tool-loop/voice-auditions.zh-CN.json`；
- 宣传钩子第二轮：`assets/demo/source/claude-tool-loop/voice-auditions-promo.zh-CN.json`；
- 茉莉稳定主讲人与术语发音测试：`assets/demo/source/claude-tool-loop/voice-auditions-moli-presenter.zh-CN.json`；
- 原创品牌音色设计与随机双 take：`assets/demo/source/claude-tool-loop/voice-auditions-brand-design.zh-CN.json`；
- 生成脚本：`scripts/generate-mimo-tts.py`；
- 试听 WAV：本地 `tmp/mimo-tts-samples/`、`tmp/mimo-tts-promo-samples/`、`tmp/mimo-tts-moli-presenter/` 与 `tmp/mimo-tts-brand-design/`，均被 Git 忽略。
