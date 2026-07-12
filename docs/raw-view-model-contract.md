# Raw Inspector View Model Contract

Raw Inspector 同时展示上行请求、模型下行、Harness 注入和捕获元数据。`src/viewer/raw-view-model.js` 是这些方向边界的纯数据模型，不操作 DOM，不读取全局状态。

## 方向约束

- 完整上行请求移除 `response`、`upstream_status` 和 `upstream_error`。
- 请求 Metadata 只保留捕获身份、请求路径、headers、context delta 和上行 composition。
- 上行 composition 移除 response text/thinking 与 output/input 派生统计。
- Response 区块独立组织完整回复、解析字段和捕获元数据。
- Tools schema 仍来自上行 request；Harness 区块由调用方显式注入已识别材料。

## Section 约束

View Model 统一生成 `system`、`tools`、`harness`、`messages`、上行 `tool_use`、`tool_result`、下行 `tool_use`、`response`、`metadata` 和完整请求的数据对象。文案翻译函数与 Harness 材料由应用层注入。

## 回归要求

`scripts/raw-view-model-contract-smoke.mjs` 锁定请求/响应隔离、不可变 composition 过滤、System 双来源、工具事件、Harness 来源以及完整 Response 的 stop reason、usage 和 capture facts。任何新增 Raw tab 都必须先明确属于上行、下行、注入信息还是捕获信息。
