# Trace Bundle Service 契约

更新时间：2026-07-12

`src/server/trace-bundle-service.mjs` 是可分享 Trace 的统一安全边界。Viewer HTTP 路由只负责 intent 校验、请求体读取和下载响应头；导出、脱敏、压缩、导入校验、provenance 补全与私有文件落盘由 Service 负责。

## 导出

1. 通过 `SourceRepository` 精确解析 source；
2. 通过 `SourceCaptureReader.readAll` 直接读取 Raw captures，不构建完整 timeline、context diff 或多 Agent 图；
3. 对常见 secret pattern 和 authorization/API key/cookie/token/password/credential/session id 字段递归脱敏；
4. 以深度和节点预算限制恶意嵌套输入；
5. 生成 `peekmyagent.trace.v1` manifest，并输出 `.peektrace.json.gz`。

导出保留合法 capture provenance。脱敏不能保证移除私有提示词、源码、路径、工具结果和业务数据，因此 manifest 继续要求用户分享前人工检查。

## 导入

- 压缩包：最大 64 MiB；
- 解压后：最大 256 MiB；
- captures：最多 5000 条；
- 只接受 `peekmyagent.trace.v1` 或兼容 legacy `proxy-captures`；
- 已有 provenance 必须通过校验，缺失 provenance 补为保守的 `trace_import`；
- `trace_id` 经过安全文件名处理，最终目录必须位于 imports 根目录内；
- imports 目录使用 `0700`，manifest 与 captures 使用 `0600`；
- 重名导入创建稳定递增后缀，不覆盖已有 Trace。

导入完成后返回只读 source，由同一个 Source Repository 出现在会话列表中。

## 回归约束

- 导出必须走 Raw capture 快路径，不读取 debug/command companion 或重建 Viewer DTO。
- 任一敏感字段名或常见 token pattern 不得出现在导出 bundle。
- gzip 放大、超量 captures、非法格式、非法 provenance 与路径穿越必须被拒绝。
- 导入和导出行为必须在 macOS、Windows、Linux 使用同一 Service；平台差异只能存在于共享 path/filesystem 边界。
