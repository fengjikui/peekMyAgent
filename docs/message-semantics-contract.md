# Trace 消息语义契约

更新时间：2026-07-14

`src/trace/message-semantics.mjs` 负责把 Harness/Agent 协议消息解释成稳定的语义类别。它回答“这条消息是什么”，但不决定它属于哪个 Turn、哪条子 Agent 分支或如何渲染。

## 所有权

该模块负责：

- 从消息历史中识别最后一条真实用户输入；
- 识别 Claude Code slash command 与本地命令输出包装；
- 识别 `/compact`、Skill、framework reminder 和 suggestion-mode 注入；
- 识别 role=`tool`、Anthropic `tool_result` 和混合 Harness continuation；
- 解析 `<task-notification>`，区分普通后台任务与子 Agent 结果回流；
- 生成稳定 entry kind、展示文本和标题清洗结果。

该模块不负责：

- 协议 content/tool block 的基础解析，后者属于 `content-parts.mjs`；
- 判断请求是 main/subagent/metadata 或建立 spawn/return 血缘；
- 比较相邻上下文、编组 Turn、统计 token 或渲染 UI；
- 收集翻译材料；翻译层只复用显式的注入文本提取端口。

## 分类优先级

从最新消息向前扫描时，framework/system 提醒先跳过；task notification、compact、Skill、真实用户输入、tool result、tool use、suggestion 和 command 按当前兼容顺序判断。这个顺序是行为契约：例如 `tool_result + compact text` 必须显示为 compact，`tool_result + "Tool loaded."` 必须保持工具结果续轮。

## 扩展规则

接入新的 Harness marker 时，先增加最小 fixture，明确它是否为真实用户文本、内部注入或结果事件，再修改本模块。不得在 Server、Turn Timeline、标题策略和 Renderer 中各自用正则猜测一次。

## 验证

```bash
npm run smoke:message-semantics-contract
```

端到端兼容继续由 `smoke:current-entry`、`smoke:claude-local-command-input`、`smoke:claude-internal-turn`、`smoke:suggestion-mode` 和 `smoke:subagent-otel` 覆盖。
