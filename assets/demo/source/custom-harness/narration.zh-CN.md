# 自研 Harness：从三次 Request 改进到两次

> 状态：中文故事 v0.2；新的 before / after 确定性 Source、1920×1080 原始帧和 21 个渐进状态的双尺寸视觉复核已经完成，等待负责人在可编辑 HTML 中审阅。

## 演示合同

- 目标用户：正在开发自有 Agent / Harness，希望知道模型为什么调用失败、该改提示词还是工具 schema 的开发者；
- 核心问题：PMA 能否把“模型表现不好”拆成可检查的上行定义、下行调用、工具结果和下一次请求，并帮助人验证改进；
- 场景：用户只问“请从 README 中找出项目入口文件，并引用原文依据”，不需要任何业务背景；
- 旧版 Harness：`read_file` 只有模糊说明，`path` 没有进入 `required`，`strict` 为 `false`；确定性模型先发送空对象，Harness 返回 `path is required`，模型重试后完成，共 3 次 Request；
- 新版 Harness：明确工具用途、`README.md` 示例和相对路径约束，并设置 `required: ["path"]`、`additionalProperties: false`、`strict: true`；同一任务一次调用成功，共 2 次 Request；
- 证据：真实 `pma observe` wrapper、真实 Capture Proxy / Viewer、确定性 OpenAI Responses 假上游；另保留 Anthropic Messages Source 验证通用协议入口；
- 限制：3→2 是这条固定场景的观察结果，不是 PMA 自动评分，也不证明真实远端模型一定获得相同幅度的改善；
- 画面：OpenAI 使用 Codex 配色；Anthropic 只在边界说明中使用 Claude 配色；1920×1080 完整三栏、无黑边；
- 隐私：固定 `/private/tmp/pma-custom-harness-demo/public-project`、公开虚构文本、占位 token、无外部请求。

## 镜头脚本与旁白

| 时间 | 用户动作与画面重点 | 要证明的价值 | 标注与停留 |
| --- | --- | --- | --- |
| 00:00–00:17 | 标题卡：同一任务，旧版 3 Request，新版 2 Request | PMA 不只记录结果，还帮助解释为什么失败、改动是否生效 | 17 秒；无编号 |
| 00:17–00:40 | `pma observe` 命令与最小任务 | 不开发专用 adapter 也能先建立可复现证据 | 23 秒；命令与任务分两步出现 |
| 00:40–01:06 | `harness-before` 全景：3 次 Request、两次 `read_file` | 先从机制流程和时间线确认“多了一次重试” | Source 1 → 机制流程 2 → Request 数 3，逐个出现 |
| 01:06–01:31 | Request 1 的 Tools | 模型能看到的只有实际发送的工具名、说明和 schema | 点击波纹 → Tools 标签轻描边 → 模糊定义 1 |
| 01:31–01:53 | 第一次 `read_file` 调用 | 空参数不是日志里的抽象失败，而是可核对的原始下行 | 调用入口波纹 → 参数区域 1；小目标使用淡色底纹 |
| 01:53–02:16 | Request 2 工具结果与第二次调用 | 错误如何回到模型、模型何时重试，可以沿关联关系定位 | 错误结果 1 → 重试调用 2；1 在 2 出现时降权 |
| 02:16–02:39 | 完整请求中的 schema | 根因在上行：`path` 没有进入 `required`，`strict` 为 `false` | 描述 1 → 缺失的 required 区域 2；框住完整 schema 组，不压文字 |
| 02:39–03:04 | 切换 `harness-after`：2 次 Request | 修改后同一任务只需要一次调用 | Source 切换波纹 → 2 Request 1 → 一次工具闭环 2 |
| 03:04–03:29 | 新版 Tools 与 Raw | 精确说明、必填参数和严格 schema 都能被逐项核对 | 工具说明 1 → `required` / `strict` 2；1 降权保留对照 |
| 03:29–03:52 | 新版工具结果与最终回答 | 改进不是主观“感觉更聪明”，而是更少重试且证据仍可追溯 | 结果 1 → 最终回答 2；1 在 2 出现时降权 |
| 03:52–04:07 | Anthropic 协议边界 | 通用入口也能观察 `tool_use` 与 `tool_result`，但不冒充专有 Harness 语义 | Claude 配色；框住完整结果组，不压文字 |
| 04:07–04:22 | 结尾卡：观察 → 定位 → 修改 → 重跑 | 形成自研 Harness 的最小人工改进闭环 | 15 秒；无编号 |

### 00:00–00:17　不是只看成功或失败

开发自研 Harness 时，“模型表现不好”往往太笼统。真正要回答的是：模型看到了什么工具定义，实际发出了什么参数，Harness 返回了什么，以及下一次请求怎样使用这个结果。PMA 把这些步骤放在同一条证据链里。

### 00:17–00:40　先用最小任务建立可复现证据

任务很简单：从 README 找出项目入口，并引用原文。用 `pma observe` 包装原来的 Harness 命令，只临时替换 child 的 OpenAI base URL。PMA 不改变工具权限，也不需要先开发专用 adapter；它只把真实协议交换送进 Viewer。

### 00:40–01:06　旧版为什么出现三次 Request

先看 `harness-before`。同一个 Turn 里有三次 Request，机制流程也出现两次 `read_file` 调用和两次结果回传。最终答案虽然正确，但中间明显多了一次失败与重试。这里先记录现象，不急着把责任归给模型。

### 01:06–01:31　模型实际看到怎样的工具

打开 Request 1 的 Tools。旧版只写“读取项目文档”，参数 `path` 的说明只有“文件”；schema 中没有 `required`，工具也不是 strict。模型不会看到 Harness 源码，它只能根据这份上行定义选择工具并组织参数。

### 01:31–01:53　第一次下行确实是空参数

点开第一次 `read_file` 调用，右栏保留结构化参数。这里不是“参数看起来不太好”，而是明确的空对象。模型只提出结构化意图；真正读取文件的仍然是本地 Harness。

### 01:53–02:16　错误怎样回到模型并触发重试

Request 2 把 `path is required` 作为与第一次调用关联的工具结果送回模型。随后模型再次调用 `read_file`，这一次才给出 `README.md`。来源链接和 call id 让错误结果、原调用与重试之间的关系可以逐步核对。

### 02:16–02:39　从 Raw 定位应该修改哪里

回到 Request 1 的完整请求，可以确认问题来自真实上行 schema：`path` 只是 properties 中的可选字段，`required` 根本不存在，`strict` 还是 false。此时更合理的动作不是给用户换一个问题，也不是盲目增加长提示词，而是先修正工具契约。

### 02:39–03:04　重跑同一任务，而不是凭感觉判断

切换到 `harness-after`。用户问题、公开目录和确定性上游都没有变化，但现在只有两次 Request：一次正确的 `read_file`，一次结果回传和最终回答。PMA 没有自动给出实验分数；它提供的是人可以复核的前后证据。

### 03:04–03:29　改动本身也能在上行中被证明

新版工具说明写清了根目录、UTF-8、相对路径和 `README.md` 示例；schema 明确出现 `required: ["path"]`、`additionalProperties: false` 与 `strict: true`。这些字段不是文档中的承诺，而是这次模型真正收到的请求内容。

### 03:29–03:52　把改善落到可观察行为

第一次调用直接带上 `README.md`，工具结果返回公开原文，最终回答引用 `src/main.mjs`。从三次 Request 降到两次，只是这条固定场景的结果；换成真实模型时仍应重跑、观察并保留失败样本。

### 03:52–04:07　通用 Anthropic 协议的观察边界

Anthropic-compatible Harness 也可以通过同一入口观察 `tool_use` 与 `tool_result`。这能证明协议级交换可见，但不能仅凭一条兼容协议轨迹声称已经理解 Claude Code 私有的 Skill、权限或子 Agent 语义；这些仍需要对应 Harness 的专用证据。

### 04:07–04:22　形成最小人工改进闭环

这套方法可以重复：先捕获一次真实任务，沿时间线定位异常 Request，回到 Tools、结果和 Raw 找根因，修改 Harness 后用同一输入重跑。PMA 的价值不是替你猜答案，而是让每一次改进都有可以复查的证据。

## 重生成

```bash
node scripts/capture-custom-harness-source-frames.mjs
node scripts/capture-storyboard-review-frames.mjs custom-harness
```

第一条命令会在固定的 `/tmp/pma-custom-harness-demo/public-project` 创建虚构 README、入门文档和入口文件，启动确定性 loopback 上游与临时 Viewer，真实运行 `harness-before`、`harness-after` 和 Anthropic 三次 `pma observe`；随后用固定 UI 操作生成 10 张 1920×1080 原始帧并自动停止服务。第二条命令根据时间线生成 1920×1080 与 1024×576 两档标注审阅帧。session 描述、脱敏终端记录、SQLite 和上游请求日志只留在 Git 忽略的 `tmp/custom-harness-protocol-demo/`。

只想保持临时 Viewer 打开做人工检查时，运行 `node scripts/custom-harness-protocol-demo.mjs`，完成后按 `Ctrl-C` 停止。
