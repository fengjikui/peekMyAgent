# Capture Response 写入事务契约

更新时间：2026-07-15

Capture Proxy 和 OTel 都可能先写入模型请求，稍后再补写模型 response。`PersistenceStore.updateCaptureResponse()` 将这次迟到更新视为一个不可分割的 SQLite 事务。

## 原子写入范围

一次成功更新必须在同一个 `BEGIN IMMEDIATE` 事务中完成：

1. 写入或复用 response content blob；
2. 写入 `response_blobs` 的 request-to-blob 关联；
3. 重算 content blob refcount；
4. 更新 `model_requests.capture_json` 中的 status、error、response、source 和 provenance；
5. 有 response 时间且提供 watch id 时，更新 watch 的 `updated_at` 与 `last_seen`。

任一步失败都必须回滚以上所有变化。不能留下只有 blob/关联却没有 Capture response，或 Capture 已更新但 watch 时间未更新的半写入状态。

## 返回和失败语义

- 缺少 `capture_id` 或数据库中不存在该 Capture：返回 `{ updated: false }`，不写任何数据。
- 全部提交成功：返回 `{ updated: true, request_id }`。
- SQL、JSON 或约束错误：回滚后抛出原始错误，由调用方按现有 ingest/runtime 语义处理。

该事务不改变 schema，也不拥有数据库连接、migration 或关闭生命周期。完整 Capture 首次写入仍使用原有独立事务；完整 Write Repository 抽离推迟到公开 alpha 后按真实需求进行。

## 确定性验证

```bash
npm run smoke:capture-response-transaction
```

该 smoke 在 `capture_json` 更新前安装一个临时 SQLite failure trigger，验证 response blob、关联、全部 blob refcount、Capture JSON 和 watch 时间完全回到更新前状态；移除 trigger 后再验证同一更新可成功提交和读取。
