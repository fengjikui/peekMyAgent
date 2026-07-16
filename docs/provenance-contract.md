# Capture Provenance 契约

更新时间：2026-07-12

`provenance` 用于回答两个不同的问题：**当前内容来自哪里、保存得有多完整**，以及 **request 与 response 为什么被认为属于同一次模型交互**。二者不能再由一个笼统的 `capture_confidence` 代替。

## v1 结构

```json
{
  "schema_version": 1,
  "transport": "capture_proxy",
  "request": {
    "origin": "network_proxy",
    "fidelity": "exact",
    "artifact": "http_request"
  },
  "response": {
    "origin": "network_proxy",
    "fidelity": "exact",
    "artifact": "http_response"
  },
  "association": {
    "method": "capture_lifecycle",
    "confidence": "exact",
    "evidence": {
      "capture_id": "...",
      "response_status": 200
    }
  }
}
```

`fidelity` 取值为 `exact | partial | missing`；`association.confidence` 取值为 `exact | high | heuristic | none`。`evidence` 只允许标量，不能复制 prompt、工具参数、回复正文或密钥。

## 当前来源语义

| transport | request/response 来源 | 关联依据 | 说明 |
| --- | --- | --- | --- |
| `capture_proxy` | 实际 HTTP 转发生命周期 | 同一 `capture_id` 生命周期 | request 为 `exact`；response 被大小上限截断时为 `partial`；关联为 `exact` |
| `otel_raw_body_file` | Claude Code 官方 OTel raw-body 事件 | 优先 `traceId + spanId`，旧版本才按文件顺序回退 | 正文可以是 `exact`，关联可能是 `exact/high/heuristic/none` |
| `trace_import` | 用户导入的 portable trace 记录 | 导入文件中同一个 capture record | 只能证明导入记录内的归组，关联最高为 `high`，不能反推原始捕获过程 |

OpenClaw 的网络请求仍由 Capture Proxy 捕获，因此 normalizer 必须保留 `capture_proxy` provenance。旧 capture 没有 provenance 时可以按已保存的 proxy 结构补齐；已有但不合法的 provenance 必须拒绝，避免错误来源被静默包装成可信证据。

## 兼容性规则

1. `schema_version` 只在结构或语义不兼容时升级；新增来源工厂不升级版本。
2. 导出 Trace 保留原 provenance；导入带合法 provenance 的 Trace 不覆盖它。
3. 老 Trace 没有 provenance 时，导入阶段写入保守的 `trace_import` provenance。
4. Viewer 可以显示旧的 `capture_method`/`capture_confidence`，但领域逻辑应以 provenance 为长期契约。
5. 新 capture source 必须提供来源、fidelity、关联方法、置信度和误判边界，并加入 contract smoke。
