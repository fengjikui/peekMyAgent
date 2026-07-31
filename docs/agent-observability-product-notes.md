# Agent 可观测与调试产品借鉴点

这份笔记只记录已核对的外部能力和对 peekMyAgent 的候选启发，不代表 roadmap 承诺。

## 值得借鉴的闭环

LangSmith 与 Langfuse 的共同强项不是单纯“多展示一些 trace”，而是把线上证据变成可复现的改进循环：

1. 从 trace 中标记失败、低质量或有代表性的样本；
2. 加入带版本的数据集；
3. 用代码规则、人工反馈或 LLM judge 评分；
4. 对同一批样本比较模型、prompt、工具或 Harness 版本；
5. 把线上新失败继续回灌数据集。

LangSmith 官方文档明确覆盖[离线/在线评测闭环](https://docs.langchain.com/langsmith/evaluation)、[并排比较与回归高亮](https://docs.langchain.com/langsmith/compare-experiment-results)和[人工标注队列](https://docs.langchain.com/langsmith/annotation-queues)。Langfuse 官方文档同样把[trace、数据集、实验、评分与线上回灌](https://langfuse.com/docs/evaluation/core-concepts)连成一体，并把[用户反馈](https://langfuse.com/docs/observability/features/user-feedback)直接关联到 trace。

对 PMA 最有价值的近期形态不是复制完整平台，而是：

- 在 Request/Trace 上增加轻量的“有问题、符合预期、备注”标注；
- 一键把已脱敏 trace 片段保存成调试案例；
- 先提供确定性检查（工具名、参数结构、注入是否存在、响应 schema、错误/重试），再接可选 judge；
- 对同一案例的两次运行做结构化 diff，突出 System/Tools/Parameters/Tool loop/Response 的改变；
- 始终把模型判断与 wire evidence 分栏显示。

## 值得借鉴的运营视角

两者都提供成本、Token、延迟、错误和质量维度的聚合；LangSmith 的[监控面板](https://docs.langchain.com/langsmith/dashboards)还按 trace、LLM、tool 和 run type 分解，Langfuse 的[指标体系](https://langfuse.com/docs/metrics/overview)支持按 model、prompt version、session、tag 等维度切片。

PMA 近期可先补“本地单项目对比”：每个 Source 的模型、参数、Token、cache、延迟、错误、工具次数和压缩次数。不急于建设团队级云端 dashboard；local-first、原始协议可核验和敏感数据不外发仍是产品差异。

## 从 CodeBuddy 2.130.0 得到的启发

安装包与隔离探针显示出几项对 Agent 调试器很实用的机制：

- 大型 tool output 可以外置，只在用户需要时读取；PMA 的 lazy payload 应继续覆盖图片、长文本和工具结果，并明确占位符与原始字节来源。
- main、lite、reasoning、subagent 可以使用不同模型；PMA 应按请求记录“实际模型 + 用途”，而不是只给整个会话一个 model 标签。
- `x-agent-purpose` 这类开发者提供的稳定 purpose/tag，比通过 prompt 猜后台任务更可靠；未来 Observer 协议可允许可选的 `trace/session/span/parent/purpose` 标记。
- 自带 OTel 说明“标准 telemetry + wire capture”可以互补：前者提供本地生命周期，后者回答模型实际看到了什么。两类证据不应互相冒充。

## 优先级建议

1. 先发布通用 Observer 和稳定的 OpenAI/Anthropic 协议查看能力。
2. 补轻量标注、保存为案例、两次运行 diff，形成最小反馈闭环。
3. 再做可插拔 evaluator 与趋势聚合。
4. Prompt 托管、团队队列、云端协作和完整成本平台放到真实用户需求验证之后。

这条顺序既保留 PMA 的协议取证优势，也吸收成熟产品真正带来复用价值的“trace → case → evaluation → comparison”闭环。
