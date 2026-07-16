# Trace 请求画像契约

更新时间：2026-07-14

`src/trace/request-profile.mjs` 把一条 Capture 的路径、请求 body、header 和已归一化消息语义解释为稳定的请求画像。它回答“这是什么协议、哪个 provider、属于主 Agent/子 Agent/metadata 中的哪一类”，但不建立 Turn 或子 Agent 血缘。

## 所有权

该模块负责：

- 汇总顶层 `system` 与 role=`system` message，保留其原始位置；
- 识别 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses 与 Gemini Generate Content 请求形状；
- 根据 model 与 capture endpoint 提示推断 provider，并记录 `thinking`、`reasoning_content` 扩展；
- 识别 `/context` token 统计、会话标题生成、WebSearch 内部请求；
- 按证据优先级区分 `main`、`subagent`、`parent_spawn` 与 `metadata`。

该模块不负责：

- 捕获、持久化或修改请求；
- 解析模型下行 SSE/JSON；
- 建立 parent/child 实例、Context Delta 或 Turn；
- 生成 Viewer HTML、统计页面数量或执行 provider 配置。

## 请求来源优先级

来源分类不是相互独立的布尔标签，而是有顺序的决策：

1. `/context`、Suggestion、framework reminder、标题生成与 WebSearch 等内部请求先归为 `metadata`；
2. `x-claude-code-agent-id`、`debug_source=agent:*`、Subagent marker 或 `api_source=agent:*` 归为 `subagent`；
3. 历史中最新的 `Agent`、`sessions_spawn` 或 `subagents` tool use 归为 `parent_spawn`；
4. 其余请求归为 `main`。

metadata 必须先于子 Agent header 判定。例如 Claude Code 的 `/context` 内部请求即使携带 Agent header，也不能制造一条子 Agent 分支。

## 证据边界

这里的 `source_hint.confidence` 表示语义分类证据，不等于 Capture provenance 的正文 fidelity 或 request/response association confidence。它不能用来宣称请求是网络层 exact capture。

provider 是根据 model/endpoint 提示得到的展示画像；unknown 是合法结果。新增 provider 时，先增加直接 fixture，再扩展本模块，不能在 Server 或 Viewer 中散落 model-name 判断。

## 验证

```bash
npm run smoke:request-profile-contract
```

直接契约覆盖 system 提取、四类协议、现有 provider、reasoning 扩展、所有 metadata/subagent/parent-spawn 判定分支和依赖方向。`smoke:claude-internal-turn`、`smoke:subagent-otel`、`smoke:agent-trace-view`、Proxy 与 Trae smoke 继续验证真实 Server 装配兼容。
