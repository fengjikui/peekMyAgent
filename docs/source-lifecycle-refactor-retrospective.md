# Source 生命周期重构与测试隔离纪要

日期：2026-07-12

## 背景

Viewer Server 原本同时负责 Source 列表拼装、标题别名、sidecar 元数据、运行中 watch、SQLite、imported Trace 文件和项目批量操作。单个 `/api/source/update` 路径混合 HTTP 输入、领域规则和多种副作用，难以独立测试，也使 rename/archive/delete 的回归影响面不清晰。

本里程碑在不改变公开 API 的前提下完成 Source 领域第一轮拆分，并在真实 daemon 验证时发现并修复一处既有 smoke 测试污染用户状态的问题。

## 实现变化

- `src/core/source-identifiers.mjs`：集中 `live/stored/watch` 标识转换；`persistence-store.mjs` 保留旧 re-export 兼容。
- `src/server/source-metadata.mjs`：集中稳定别名、metadata 合并、title/pin/hidden 装饰和 `source-meta.json` 原子写入。
- `src/server/source-lifecycle-service.mjs`：通过 repository、runtime、store、metadata、imports 显式端口编排 rename、pin、archive、delete 和项目批量动作。
- `src/viewer/server.mjs`：Source update 路由只读取 JSON、装配端口并调用 service；移除约 270 行 Source 生命周期与元数据实现。
- imported Trace 删除继续校验 `path.relative(importsRoot, target)`，拒绝删除 imports 根目录自身或越界路径。

## 测试污染问题

### 现象

真实 daemon 的 Source 列表出现 `imported-title-sanitize-smoke`、`imported-title-sanitize-smoke-2`。这些会话不是用户数据，却在发布门禁后留在真实 `~/.peekmyagent/imports`。

### 误判与证据

最初怀疑 `trace-bundle-smoke` 没有隔离状态；检查源码后发现它已经在启动 Viewer 前设置临时 `PEEKMYAGENT_STATE_DIR`，该假设被排除。全仓搜索固定 trace id 后，定位到 `security-boundary-smoke.mjs` 的 title sanitize import 场景。

### 根因

`security-boundary-smoke` 仅传入临时 `storePath`。SQLite 因此被隔离，但 `startViewerServer()` 仍通过全局状态目录解析 imports 路径，测试导入包写入了用户真实状态目录。测试结束只删除临时 SQLite 目录，无法清理真实 imports。

### 修复

- 测试启动前保存并设置 `PEEKMYAGENT_STATE_DIR=tmp`。
- finally 中恢复原环境变量并删除临时目录。
- 通过真实 API 删除已存在的两个测试 import。
- 再次运行 security smoke，并检查真实 `/api/sources`，确认没有重新产生残留。

## 新增契约测试

- `smoke:source-metadata-contract`：稳定键、别名继承、原子写入、重启读取、hidden/pinned 排序。
- `smoke:source-lifecycle-service`：persisted/imported/live/static Source 的重命名、归档、删除、项目删除约束和目录越界保护。
- 既有 `source-meta`、`project-source-actions`、`trace-bundle`、`watch-current`、`watch-pause-resume`、`security-boundary` 继续作为端到端兼容门禁。

## 验证证据

聚焦验证：

```bash
npm run smoke:source-metadata-contract
npm run smoke:source-lifecycle-service
npm run smoke:persistence-store
npm run smoke:source-meta
npm run smoke:project-source-actions
npm run smoke:trace-bundle
npm run smoke:watch-current
npm run smoke:watch-pause-resume
npm run smoke:security-boundary
npm run smoke:package
```

真实 daemon 验证：

1. `pma restart` 加载当前工作树。
2. 创建临时 live watch。
3. 依次执行 rename + pin、archive、delete。
4. 检查 `/api/sources`，确认临时 source 与 conversation 均无残留。
5. 单独重跑 security smoke 后再次检查真实 Source 列表，确认测试 import 未重现。

## 剩余边界

- watch 的 start/reuse/restore/pause/resume/stop 尚在 Viewer Server。
- live/SQLite/file/imported Trace 的 capture 读取尚未形成统一 reader。
- 当前 metadata sidecar 是文件级原子写入，不是与 SQLite 的跨介质事务；进程在两次写入之间异常退出时仍可能短暂不一致。
- Windows/Linux 真实机器尚未在本分支验证；完整三平台托管 CI 和发布前真实机器检查仍为合并条件。

## 最终状态

- `npm run release:check:macos`：通过，耗时 249.0 秒；新增两个契约已进入正式门禁，所有既有检查退出码均为 0。
- 发布门禁结束后访问真实 daemon `/api/sources`：2 个用户 Source，0 个 smoke/refactor/title-sanitize 残留。
- 本机 daemon 已使用当前工作树重启，地址仍为 `http://127.0.0.1:43110`。
- 托管三平台 CI 与 Windows/Linux 真实机器验证等待分支推送后的共享验证流程。
