# Coding Agent 代码库地图

更新时间：2026-07-14

本文帮助 Codex、Claude Code 和其他 Coding Agent 在几分钟内找到正确改动边界。它不是第二份架构事实源：运行行为以[当前架构](architecture.md)为准，未来设计以[重构路线图](refactoring-roadmap.md)为准，协作和验证规则以仓库根目录的 `AGENTS.md` 为准。

## 开始工作前

1. 执行 `git fetch origin`、`git status --short --branch`、`git rev-parse HEAD` 和 `git rev-parse origin/main`。
2. 阅读 `AGENTS.md`、本文、`docs/architecture.md` 和改动领域的契约文档。
3. 从真实调用链追踪行为，不要根据旧对话或文件名猜实现。
4. 先写或找到能证明行为的确定性 smoke，再改代码。

## 一条 Trace 如何流动

```text
pma CLI / adapter
  -> Capture Proxy 或 OTel ingestor
  -> CaptureRecord + provenance
  -> SQLite content blocks / request tree
  -> SourceRepository + domain services
  -> Viewer HTTP API
  -> browser API client + store
  -> feature model/controller/renderer
```

每一层只拥有一类责任：adapter 发现和启动 Agent，capture 层保存证据，Trace Domain 建立语义关系，repository/service 管数据与副作用，HTTP route 做协议适配，Viewer feature 负责展示和交互。

## 按需求定位

| 要修改的行为 | 首先阅读 | 通常不应直接修改 |
| --- | --- | --- |
| CLI 命令、wrapper、进程退出、安装卸载 | `bin/`、`src/core/platform.mjs`、`paths.mjs`、`processes.mjs` | Viewer renderer |
| Proxy 请求/回复捕获 | `src/core/capture-proxy.mjs`、`provenance.mjs` | UI 文案 |
| Claude Code OTel 关联 | `src/core/otel-capture.mjs`、`otel-events.mjs`、`src/adapters/claude-code-otel.mjs` | Source 标题策略 |
| OpenClaw/Trae 或新 Agent | `src/adapters/`、对应 integration、适配器 fixture | 在 Server/Client 散落 provider 条件分支 |
| SQLite、内容块、迁移 | `src/core/persistence-store.mjs`、`src/persistence/migrations/` | 绕过 migration 直接改 schema |
| content、thinking、tool use、tool result 基础解析 | `src/trace/content-parts.mjs`、对应 contract smoke | 在上行/下行各维护一份 block 解析 |
| 真实用户输入、slash command、Harness 注入、任务通知 | `src/trace/message-semantics.mjs`、对应 contract smoke | 在 Server/Turn/标题/UI 各写一套 marker 正则 |
| 请求协议/provider、main/subagent/metadata 来源画像 | `src/trace/request-profile.mjs`、对应 contract smoke | 在 Server/Viewer/adapter 中散落 model、path 或 header 判断 |
| 请求 System/Tools/消息/工具交互字符构成 | `src/trace/request-composition.mjs`、对应 contract smoke | 在 Viewer Server 或 Renderer 中重新统计 payload |
| 模型下行 JSON/SSE、usage、stop reason | `src/trace/model-response-normalizer.mjs`、对应 contract smoke | 在 Viewer Server/renderer 按 provider 重写解析 |
| Turn、context delta、子 Agent 血缘 | `src/trace/` 和对应 contract smoke | Viewer 中重新猜测关系 |
| Source 列表、读取、重命名/归档/删除 | `src/server/source-*` provider/repository/service | HTTP route 直接操作文件或 SQLite |
| 左侧 Source/项目导航与菜单 | `src/viewer/session-navigator-*`；应用副作用在 `client.js` | 每次渲染重新绑定按钮或 renderer 直接调用 API |
| Trace 导入导出与脱敏 | `src/server/trace-bundle-service.mjs`、`src/core/redaction.mjs` | 浏览器自行拼 bundle |
| 大 Trace 首屏、file sidecar、cursor 续读、跨页语义和 Client normalized store | `json-array-file-index.mjs`、`source-capture-reader.mjs`、`timeline-cursor-service.mjs`、`timeline-page-assembler.mjs`、`timeline-view-projector.mjs`、`TimelineEntityStore`（`timeline-entity-store.js`）、[文件索引契约](json-array-file-index-contract.md)、[分页契约](timeline-pagination-contract.md) | 修改原始 Trace、在 route 暴露 reader offset、每页重复完整 Turn/Agent 图，绕过 Store 改 `state.data`，或重新下载整条 compact Trace |
| Viewer HTTP 安全和 API | `src/server/http.mjs`、`src/viewer/server.mjs`、`src/viewer/api-client.js` | feature renderer 发 `fetch` |
| 中栏 Timeline、请求卡、多 Agent 看板、上行详情 | `trace-timeline-*`、`request-card-renderer.js`、`agent-graph-*`、`upstream-detail-*` | renderer 读取全局 `state` 或 DOM |
| Raw、Messages、翻译展示 | `raw-*`、`message-*`、`translation-*` | `client.js` 新增长段领域 HTML |
| System 提示词变化与大文本退化 | `system-diff-model.js`、`system-diff-renderer.js`、[System Diff 契约](system-diff-view-contract.md) | 在 `client.js` 重建无上限 LCS 矩阵，或把块摘要称作精确行 diff |
| 三栏折叠、宽度与拖动 | `pane-layout-model.js`、`pane-layout-controller.js`；状态在 `client-store.js` | 在 `client.js` 直接读写 CSS 变量或重复绑定 resizer |
| UI 状态与交互动作 | `client-store.js`、feature controller、`session-navigator-*`、`agent-composer-*`、`client.js` 装配层 | model/renderer 写全局状态 |
| 中英文 UI 文案 | `src/viewer/ui-i18n.js` 和 `scripts/viewer-i18n-contract-smoke.mjs` | 只改一种语言或在 feature 内另建词典 |

## Viewer Feature 约定

新 Viewer 功能优先形成以下边界，而不是继续扩张 `client.js`：

- **Model**：纯数据到 View DTO；不得访问 DOM、网络或全局状态。
- **Renderer**：显式 DTO 到安全 HTML；普通文本必须转义，Markdown 使用受限 renderer。
- **Controller**：长期持有 DOM 节点、做一次事件委派，通过动作端口通知应用层。
- **Application assembly**：读取 store、调用 API/service、注册翻译动作并决定局部重绘范围。

不是每个功能都必须凑齐四个文件。只有存在独立责任、显式输入输出和可直接验证的契约时才拆分。

## 验证与文档

- 开发中先运行改动模块的直接 contract smoke。
- Level 1 低风险代码累计到 3 个提交、准备推送代码批次或出现跨模块不确定性时，运行当前主机完整 release profile。
- CLI、进程、路径、端口、安装、SQLite 和 provider 配置属于高平台风险，必须按 `docs/validation-strategy.md` 执行 Level 2。
- 当前行为变化同步更新 `docs/architecture.md`；未来计划只写入 roadmap；复杂修复保留 evidence/retrospective。
- 新增 UI 文案必须同步更新 `ui-i18n.js` 的中英文 key，并运行 `npm run smoke:viewer-i18n-contract`；该门禁同时检查占位符和源码/HTML 的静态 key 引用。

查看可用 smoke：

```bash
npm run release:check:macos:list
npm run release:check:windows:list
npm run release:check:linux:list
```
