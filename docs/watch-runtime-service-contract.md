# Watch Runtime Service 契约

更新时间：2026-07-14

`src/server/watch-runtime-service.mjs` 管理 Capture Proxy watch 的运行期生命周期。它位于 Viewer Router、共享/独立 Capture Proxy、SQLite watch store 和 Source 服务之间；`src/viewer/server.mjs` 只负责实例化这些依赖并把端口连接起来。

## 调用链

```text
pma wrapper / Viewer API / stable Agent route
  -> ViewerRouter                    HTTP 安全、intent、body 和响应适配
  -> WatchRuntimeService             active registry 与生命周期决策
  -> shared 或 dedicated proxy       原始请求转发与捕获
  -> PersistenceStore                watch、capture 与 response 持久化
  -> SourceRepository / Reader       只读 Trace 展示
```

底部 Composer 不再自行恢复 watch。`AgentSendService` 通过 `resolveForSend(sourceId)` 窄端口取得 active 或持久化 watch；`SourceCaptureReader` 通过 `resolveWatch` 和 `capturesForWatch` 只读端口读取 live captures；`SourceLifecycleService` 通过 get/remove/close/values 端口做归档和删除。

## 公共能力

- `start(input)`：统一处理新建、自动复用和显式 `reuse_watch_id`，返回 `{ watch, disposition }`。
- `setPaused(selector, paused)`：在不停止转发的前提下切换捕获状态。
- `stop(selector)`：停止或清空 active watch。
- `resolveForCapture(watchId)`：共享 `/watch/:id` 冷启动时恢复仍为 watching/paused 的持久化 watch。
- `resolveForAgentRoute(context)`：把稳定 Agent 路由解析为 watch，并复用已有历史 captures。
- `resolveForSend(sourceId)`：为页面 detached Agent send 查找或恢复 watch。
- `onCapture`、`onCaptureUpdate`、`onCaptureSkipped`：统一更新 runtime 状态并写入 Store。
- `find/get/has/listActive/values/remove/capturesFor`：向 Source 与装配层暴露窄运行时端口，不暴露可变 Map。
- `closeWatch/close`：幂等关闭独立代理和共享代理；Service 不关闭外部注入的 SQLite Store。

Router 需要的 `mode_label`、中文 instructions 和 HTTP `reused` 字段仍由 Viewer presenter 生成，不进入运行时领域对象。

## 所有权与端口

Service 拥有：

- active watch registry 与并发 start/restore 锁；
- shared/dedicated proxy 引用和关闭状态；
- new/reused/restored 状态转换；
- request capture 回调、conversation id 学习和运行期时间字段；
- paused 状态下“继续转发、跳过捕获”的行为。

外部端口拥有：

- `PersistenceStore`：lossless `loadWatch/findReusableWatch`、watch/capture 持久化和历史 captures；
- metadata port：首选标题、conversation 稳定别名提升和 clear 时别名删除；
- upstream resolver：按 Agent/环境解析真实 provider base URL；
- dynamic route resolver：Trae CN 等适配器的 provider/workspace/session 归属；
- Capture Proxy：HTTP 协议、请求大小、网络转发和 request counter。

## 关键不变量

1. `watch_id` 在 reuse、daemon restart、Composer 恢复和 shared proxy 冷恢复后不变。
2. 显式 `reuse_watch_id` 不存在时必须返回 HTTP 409；不能悄悄创建新会话。
3. 新 watch 必须在客户端拿到代理 URL 并发出首个请求前落库。
4. paused watch 继续把请求转发给 provider，但不插入 capture，并累计 `skipped_while_paused`。
5. shared proxy 冷恢复必须保留持久化 paused 状态；用户主动 start/reuse 才恢复为 watching。
6. paused 的 dedicated watch 若代理仍存活，resume 复用原代理，不能泄漏第二个监听端口。
7. 持久化恢复先向 proxy 注入历史 captures，使 `request_index` 从已有最大值继续递增。
8. Capture 入库或 metadata side effect 失败不得阻断 Agent 上游请求；错误必须写入本地诊断日志。
9. Service close 幂等；共享代理只关闭一次，单个 shared watch 的 stop 不得关闭整个共享端口。
10. Store、Source metadata 和 HTTP DTO 仍是独立边界；运行时对象不能直接成为公开 API。

## 当前明确暂缓

以下问题需要 schema 或 Capture Proxy cache 协议升级，不在本次行为保持型抽离中混做：

- `paused_at/resumed_at/stopped_at/skipped_while_paused/provider_id/config_patched` 的完整持久化；
- shared proxy 对单个 watch 的 capture cache/counter 清理；
- persisted-only watch 在不恢复代理时直接 pause/stop 的控制面；
- 大 watch 恢复时避免一次性 hydrate 全部 request body。

这些内容只能在增加 migration 和独立回归测试后实现，不得把计划描述成当前能力。

## 安全与验证

Capture 回调会处理用户 prompt、工具参数、文件路径和 provider response。Service 只能把内容交给本机 SQLite 与本机 Viewer，不得新增非 loopback 输出。动态路由和 Composer 仍必须经过 Viewer/Capture HTTP 安全边界。

开发时至少运行：

```bash
npm run smoke:watch-runtime-service-contract
npm run smoke:watch-current
npm run smoke:watch-pause-resume
npm run smoke:shared-proxy-auto-restore
npm run smoke:agent-send
npm run smoke:persistence-store
```

Watch、端口、Capture 和 SQLite 属于高平台风险；提交前必须运行当前主机完整 release profile，并由三平台 CI 验证。
