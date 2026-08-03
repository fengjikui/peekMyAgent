# 用 PMA 读懂 Codex 的 System 与 Tools

> 状态：中文故事 v0.2；Codex 形状教学 Source、确定性本地翻译缓存、1920×1080 Viewer 原始帧和 18 个渐进状态的双尺寸视觉复核已经完成，等待负责人在可编辑 HTML 中审阅；历史无声母版不用于当前版本。

## 演示合同

- 目标用户：面对英文 System、Developer 指令或工具 schema 时，希望快速理解但仍需保留原始证据的 PMA 用户；
- 核心问题：怎样在不改 Capture 的前提下，分块阅读 System 和 Tools，并随时回到对应原文；
- 场景：用户问“第一次用 Codex 参与项目，修改代码前先读哪两个文件”，公开教学 Source 通过 `list_directory` 得到 `AGENTS.md` 与 `README.md`；
- 证据：真实 PMA Capture Proxy、确定性 OpenAI Responses 假上游、1 Turn / 2 Request、3 个 System 翻译块、7 个 Tools 翻译块；
- 结果：System 被拆成 Codex 角色、仓库指令和回答约定三张卡片；Tools 只翻译说明文字，工具名、参数名和 schema 标识符保持原文；
- 限制：翻译由固定 loopback 上游生成，只证明当前 Viewer 与缓存行为，不证明外部翻译模型质量；
- 身份边界：这是公开、确定性的 Codex 形状教学请求，不宣称由真实 Codex CLI 产生；
- 画面：Codex 配色、1920×1080 完整三栏、无黑边、底部居中单句字幕；
- 隐私：固定 `/tmp/pma-translation-codex-demo/public-project`、公开虚构提示词、占位 token、无外部请求。

## 镜头脚本

| 时间 | 用户动作与画面重点 | 要证明的价值 | 标注与停留 |
| --- | --- | --- | --- |
| 00:00–00:16 | 标题卡：用 Codex 请求理解翻译层 | 熟悉的编程 Agent 场景更容易理解；原文仍是事实源 | 16 秒；无编号 |
| 00:16–00:36 | 查看两 Request 工具闭环；顶部目标语言 → Request 1 `详情` | 先选目标语言，再打开要读的请求 | 目标语言 1 → Request 1 详情 2，交叉淡出 |
| 00:36–01:00 | 点击 `System`，保持 `原文` | 原始三块 System 与缓存状态都可见 | 标签轻描边；模式 1 → 原始块 2 |
| 01:00–01:28 | 切换 `中文（简体）` | 三个来源块分别翻译，不合并成无法核对的摘要 | 缓存 1 降权后出现三张卡片 2 |
| 01:28–01:54 | 展开第二张卡片的 `原文` | 同一位置比较译文与对应英文约束 | 译文 1 降权后出现原文 2 |
| 01:54–02:16 | 点击 `Tools`，保持 `原文` | 两个声明工具和五个参数说明按工具分组 | 标签轻描边；工具 1 降权后出现工具 2 |
| 02:16–02:46 | 切换 Tools 译文 | 说明文字变为中文，标识符保持原样 | 缓存 1 降权后出现标识符与译文 2 |
| 02:46–03:12 | 回到 `完整请求` | 翻译缓存不重写请求，Raw 仍保留英文和脱敏 header | 脱敏 1 降权后出现原始工具定义 2 |
| 03:12–03:28 | 结尾卡：目标语言 → 分块译文 → 对应原文 → Raw | 形成可复述的阅读顺序 | 16 秒；无编号 |

## 完整旁白

### 00:00–00:16　翻译不替代原文

第一次研究 Codex 时，最容易被长英文 System 和工具 schema 挡住。PMA 可以把这些内容按来源翻译成中文，但不会重写 Capture；只要结论涉及精确字段，仍然要回到对应原文。

### 00:16–00:36　先选目标语言，再打开请求

这个任务没有业务背景：用户只问第一次用 Codex 修改代码前先读哪两个文件。Request 一得到目录工具调用，Request 二回传 `AGENTS.md` 与 `README.md` 并回答。顶部“翻译”选择中文简体，再点 Request 一的详情，进入这次模型上行的证据。

### 00:36–01:00　System 原文先建立来源结构

进入 System 时先保持原文。右栏显示三个 system message，分别说明 Codex 角色、仓库指令和回答约定；顶部同时显示三分之三已经缓存。缓存命中只表示辅助译文存在，下面这三块英文仍然是原始请求事实。

### 01:00–01:28　三块 System 分别翻译

切到中文简体后，三块内容仍然保持原来的边界：第一张说明这是 Codex，第二张保留 `AGENTS.md` 与 `README.md` 的仓库规则，第三张保留编号步骤。PMA 没有把它们合成一段摘要，因此你仍然知道每句译文来自哪一个 system message。

### 01:28–01:54　在同一张卡片展开对应原文

展开第二张卡片的原文，中文仓库指令和英文 `Repository instructions` 出现在同一个区域。这样既能快速阅读，也能逐字核对“先读哪些文件、工作范围在哪里、哪些标识符必须保留”，不用依赖另一份脱离请求的翻译文档。

### 01:54–02:16　Tools 先按工具查看原文

再进入 Tools，并切回原文。这里声明了 `list_directory` 和 `read_file` 两个工具；每个工具的说明和参数说明都单独分组。工具名和 `path`、`max_depth`、`start_line`、`end_line` 是协议标识符，不应被翻译。

### 02:16–02:46　只翻译说明文字，保留 schema 标识符

切到中文后，工具用途和参数说明变得容易阅读，但 `list_directory`、`path` 和 `max_depth` 仍然保持原样。顶部七分之七表示这次 Tools 区块的七条可翻译材料都命中缓存；它不表示整个 JSON schema 被改写成中文。

### 02:46–03:12　最后用完整请求确认 Capture 没有变化

最后回到完整请求。Authorization 已按规则脱敏，request body 里的工具名、英文 description 和参数 schema 仍是捕获到的原始内容。翻译缓存只是 Viewer 的辅助状态，不会成为新的上行请求，也不会覆盖 Raw。

### 03:12–03:28　形成可重复的阅读顺序

完整顺序是：先选择目标语言，在 System 或 Tools 中按块阅读译文，需要时展开对应原文，涉及精确字段再回到 Raw。翻译帮助理解，原文负责定案。

## 重生成

```bash
node scripts/capture-translation-source-frames.mjs
node scripts/capture-storyboard-review-frames.mjs translation
```

第一条命令会创建固定虚构目录，启动确定性模型上游、确定性翻译上游与临时 Viewer，通过真实 Capture Proxy 生成两次 Request，再用真实翻译接口为 Request 1 写入 3 个 System 和 7 个 Tools 缓存块；随后用固定 UI 操作生成 7 张 1920×1080 原始帧并自动停止服务。第二条命令根据时间线生成 1920×1080 与 1024×576 两档标注审阅帧。Session 描述、SQLite 与本地请求日志只留在 Git 忽略的 `tmp/translation-viewer-demo/`。

只想保持临时 Viewer 打开做人工检查时，运行 `node scripts/translation-viewer-demo.mjs`，完成后按 `Ctrl-C` 停止。
