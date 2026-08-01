# 自研 Harness：用通用协议桥看清一次工具闭环

> 状态：中文故事 v0.1；真实 `pma observe` Source、1920×1080 Viewer 原始帧和 1920×1080 / 1024×576 两档渐进标注审阅已完成，等待所有者内容审阅。

## 演示合同

- 目标用户：正在开发自有 Agent / Harness，希望先核对 HTTP 请求、工具交换和上下文的开发者；
- 核心问题：不开发专用 adapter，能否先看清 OpenAI Responses 或 Anthropic Messages 的真实交换；
- 场景：一个只读目录助手列出虚构公开目录的第一层，并说明新用户先看哪个文件；
- 证据：真实 `pma observe` wrapper、确定性 loopback 上游、两个协议各 2 次 Request 与 1 次工具闭环；
- 限制：不证明 Skill、权限、压缩、恢复或子 Agent 私有语义，也不评价远端模型能力；
- 画面：OpenAI 使用 Codex 配色，Anthropic 使用 Claude 配色，完整三栏、无黑边；
- 隐私：固定 `/private/tmp/pma-custom-harness-demo/public-project`、公开虚构文本、占位 token、无外部请求。

## 镜头脚本与旁白

| 时间 | 用户动作与画面重点 | 要证明的价值 | 标注与停留 |
| --- | --- | --- | --- |
| 00:00–00:17 | 标题卡：OpenAI / Anthropic → `pma observe` → Viewer | 先验证协议，不必先开发 adapter | 17 秒；无编号 |
| 00:17–00:42 | 展示 `--name`、`--base-url-env` 与 `--` 命令边界 | 只有 child base URL 被临时覆写；权限仍属于 Harness | 25 秒；命令卡慢读 |
| 00:42–01:06 | OpenAI Source 全景：Source 名称、机制流程、2 Request | 一个最小目录任务即可看懂完整工具闭环 | 编号 1 → 2 交叉淡化 |
| 01:06–01:32 | Request 1 Metadata | 模型、temperature、输出上限和上行构成都可核对 | 标签轻描边；1 保留并降权后出现 2 |
| 01:32–01:53 | Request 1 Tools | 模型只能根据工具说明和 schema 提出调用 | 标签轻描边 → 证据编号 1 |
| 01:53–02:14 | 点击 `list_directory` 调用 | 模型下行是结构化意图，不是直接访问磁盘 | 编号 1 → 2 交叉淡化 |
| 02:14–02:37 | 点击工具结果 | Harness 执行后，结果通过下一次请求回到模型 | 编号 1 → 2 交叉淡化 |
| 02:37–03:06 | Request 2 协议视图 | OpenAI Responses 的 user / function_call / function_call_output / final output 原生顺序 | 标签轻描边；编号 1 → 2 |
| 03:06–03:28 | Request 1 完整请求 | Raw 保留请求字段并明确记录 Header 脱敏 | 标签轻描边 → 编号 1 |
| 03:28–03:58 | 切换 Anthropic Source 与 Claude 配色，查看 Request 2 协议 | 同一入口按 wire 事实识别 Anthropic；tool_use 和 tool_result 原生 role 不被摘要改写 | 标题轻描边；1 降权后出现 2 |
| 03:58–04:11 | 结尾卡：通用桥的能力与限制 | 先定位协议问题，再决定是否开发专用 adapter | 13 秒；无编号 |

### 00:00–00:17　先观察协议，再决定是否开发 adapter

开发自研 Agent 时，你通常先想知道请求到底发对了没有，而不是马上再写一个 PMA adapter。只要 Harness 从环境变量读取 OpenAI 或 Anthropic 的 base URL，`pma observe` 就能先把真实协议交换放进 Viewer。

### 00:17–00:42　一个命令只改变 child 环境

命令分成两边。双横线前告诉 PMA Source 名称和需要临时覆写的变量；双横线后仍是原来的 Harness 命令。PMA 先读取真实上游，再只在 child 进程中把这个变量换成本地代理。父 shell、用户配置和其他进程都不变。这里也没有 PMA 的完全权限参数，因为审批和工具权限属于你的 Harness。

### 00:42–01:06　两次 Request 形成最小工具闭环

这条 Source 来自真实 `pma observe` 和确定性本地上游。任务只要求列出公开目录，再说明新用户先看哪个文件。PMA 显示一个 Turn、两次 Request：模型先选择 `list_directory`，Harness 本地执行，第二次请求回传目录结果，模型最后回答先看 README。

### 01:06–01:32　先核对模型参数和上行构成

打开 Request 1 的 Metadata，可以直接核对模型、`temperature`、最大输出 token 和请求路径。再往下看上行构成，System、Tools、当前用户和参数分别占多少一目了然。这里的 Source 名称只是标签；协议事实来自实际路径和 body。

### 01:32–01:53　模型为什么能选择这个工具

切到 Tools，Viewer 展示 Harness 实际发送的 `list_directory` 定义：用途是列出公开目录的第一层内容，参数 `path` 是相对目录。模型不是凭空知道本地函数；它只能根据这份工具名、说明和 schema 提出结构化调用。

### 01:53–02:14　模型下行只提出动作

第一次模型回复不是自然语言答案，而是 `function_call`。中栏先显示 `list_directory` 调用；右栏再展开原生类型、call id 和参数 `path: "."`。模型只输出文本形式的结构化意图，并没有直接访问磁盘。

### 02:14–02:37　Harness 执行后把结果送回下一次请求

Harness 在本地列出目录，再把结果封装成第二次请求的 `function_call_output`。中栏说明它已关联调用，并提供“来源 #1”；右栏保留 call id 和实际 `entries`。这样可以检查结果是否确实回给了模型，而不是只看到终端说工具成功。

### 02:37–03:06　回到 OpenAI Responses 原生顺序

摘要仍不够时，协议视图明确写出 OpenAI Responses。第二次上行按顺序包含用户消息、assistant 的 `function_call`，以及 tool 角色的 `function_call_output`；下行才是最终 Assistant 消息。每一项都保留 JSON path，用来排查兼容层是否漏传或改错顺序。

### 03:06–03:28　Raw 保留完整请求，也显示脱敏事实

完整请求保留模型、instructions、工具 schema、参数、input、路径和捕获信息。这里还能看到 `authorization` 已替换成脱敏占位符，并记录 `sensitive_header` 原因。Header 脱敏不等于正文安全；公开截图前仍要人工检查 System、用户内容、工具参数和结果。

### 03:28–03:58　同一入口也能观察 Anthropic Messages

把变量换成 Anthropic base URL，同一个 `pma observe` 入口会按真实 wire path 识别 Anthropic Messages，并使用 Claude 配色审阅。这里的工具调用是 assistant 的 `tool_use`；结果则位于后续 user message 的 `tool_result`。摘要可以统一叫工具调用和结果，但原生角色不能被改写。

### 03:58–04:11　通用桥证明协议，不猜 Harness 私有机制

通用桥已经证明请求、回复、工具交换和 Raw 被精确捕获；它不会仅凭品牌名猜测 Skill、权限、压缩、恢复或子 Agent 关系。先用这条最小路径定位协议问题，只有确实需要 Harness 私有语义时，再根据真实 Evidence Pack 开发专用 adapter。

## 重生成

```bash
node scripts/custom-harness-protocol-demo.mjs
```

脚本会在固定的 `/tmp/pma-custom-harness-demo/public-project` 创建虚构文件，启动确定性 loopback 上游与临时 Viewer，真实运行 OpenAI 和 Anthropic 两次 `pma observe`，把 session 描述、脱敏终端记录、SQLite 和上游请求日志留在 Git 忽略的 `tmp/custom-harness-protocol-demo/`。保持脚本运行，再在 1920×1080 浏览器中采集 Viewer；退出时按 `Ctrl-C`，Source 数据仍留在临时 store 供本地复核。
