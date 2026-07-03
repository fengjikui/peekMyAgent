# 发布前安全与性能审计纪要

更新时间：2026-07-04

本文记录 peekMyAgent 面向公开发布前的安全与性能检查结果。它不是一次性的“安全认证”，而是维护者后续改动时需要持续回看的工程边界。

## 核心结论

- 默认运行形态应始终是本机优先：dashboard、capture proxy 和 daemon 默认只绑定 loopback。
- 捕获数据可能包含 system prompt、工具 schema、上下文、源码片段、命令输出、API 配置片段和个人信息。任何导出、分享、长期留存都应被视为敏感操作。
- 页面性能的主要风险来自大 Trace：左侧会话列表、Raw JSON、搜索和翻译 action 如果全量重建，会在长会话中明显卡顿。
- 当前已补上本地 API 边界、防滥用大小限制、路径安全、上游 URL 校验、轻量列表路径和对应 smoke 测试。

## 威胁模型

| 风险面 | 典型问题 | 当前策略 |
| --- | --- | --- |
| 本地 dashboard API | 恶意网页通过浏览器向 `127.0.0.1` 发起状态修改请求 | 拒绝跨站 `Origin` / `Referer`，状态修改接口要求 JSON content-type |
| 远程暴露 | 用户误把 dashboard/proxy 绑定到 `0.0.0.0` | 默认拒绝非 loopback host；远程暴露必须显式 unsafe opt-in |
| Capture proxy | 被当成通用 SSRF/open proxy | 上游 URL 只允许 `http:` / `https:`，剥离 hop-by-hop、proxy 和内部 `x-peek-*` 头 |
| 大请求/导入包 | 请求体、gzip Trace、导入 captures 过大导致内存或 CPU 放大 | JSON body、captured request、Trace 压缩/解压大小和 capture 数量都有上限 |
| 文件路径 | 翻译语言、导入目录、OTel 扫描造成路径穿越或大目录扫描 | 语言名经过 path segment 归一化；OTel 读取限制文件数、目录数和单文件大小 |
| 数据留存 | raw body 长期保存或导出泄露敏感内容 | README/隐私文档明确说明；Trace 导出默认脱敏常见 secret/token pattern，并在导出前提示用户自审 |
| 同机恶意进程 | 本机其他进程直接访问本地端口 | 当前不把同机恶意进程视为完全可防边界；后续可考虑 session token/Unix socket |

## 已落地的安全修复

- `src/viewer/server.mjs`
  - 拒绝非 loopback 绑定，除非显式开启 unsafe remote。
  - 为本地 API 增加 `Origin` / `Referer` / JSON content-type 防护。
  - 为 dashboard、JSON API 和 Trace 导出统一增加基础浏览器安全响应头：`nosniff`、`no-referrer`、`COOP` 和限制脚本/对象/嵌入的 CSP。
  - 限制普通 JSON body、Trace 导入体积、gzip 解压体积和导入 capture 数量。
  - 翻译目标语言进入缓存路径前做安全归一化。
  - 导入 Trace 列表优先使用 manifest 统计，避免列会话时解析完整大文件。
  - Trace 导出包默认递归脱敏常见 token/API key 字符串，并在 manifest 标记脱敏策略与隐私提示。
- `src/core/capture-proxy.mjs`
  - 限制捕获请求体大小。
  - 校验上游 URL 协议，只允许 `http:` / `https:`。
  - 过滤 hop-by-hop/proxy/internal headers。
- `src/core/otel-capture.mjs`
  - 限制 OTel 目录扫描规模和单个 JSON 文件大小。
- `bin/peekmyagent.mjs`
  - `shutdown/restart --force` 不再杀未知端口占用者，只允许清理 registry 中确认属于 peekMyAgent 的进程。
- `src/core/platform.mjs`
  - Windows 打开浏览器改用 `rundll32.exe url.dll,FileProtocolHandler`，避免 `cmd /c start` 的 shell 语义。

## 已落地的性能修复

- 左侧 live watch 列表直接使用 capture 轻量字段，不再为了列表构建完整 request timeline。
- 导入 Trace 列表优先读 manifest 统计，不在 `/api/sources` 解析完整 `proxy-captures.json`。
- Response Raw 默认展示最终解析结构和捕获元数据，不把 SSE/stream 原文整段下发到 viewer；大流式响应通过 `body_text_omitted` 标记保留可解释性。
- Raw JSON 搜索增加 debounce，减少大 JSON 下的连续重渲染。
- 切换/刷新视图时清理旧翻译 action 状态，避免长时间使用后积累无效 UI 状态。
- 重命名持久化到 SQLite/import manifest，刷新后不再恢复旧标题。

## 新增/扩展的自动验证

- `npm run smoke:security-boundary`
  - 覆盖非 loopback 绑定拒绝、跨站 POST 拒绝、非 JSON 状态修改拒绝、基础安全响应头、不安全语言路径拒绝、超大 Trace capture 数拒绝。
- `npm run smoke:source-list-performance`
  - 构造一个 manifest-backed 大 Trace，故意让 `proxy-captures.json` 不可解析；`/api/sources` 仍应能列出它，防止会话列表退回全量解析慢路径。
- `npm run smoke:persistence-store`
  - 覆盖会话重命名跨 viewer restart 持久化。
- `npm run smoke:platform`
  - 覆盖跨平台 browser opener 命令。

这些 smoke 已加入 `scripts/release-check.mjs` 的发布门禁。

## 剩余风险与后续建议

- 本机恶意进程仍可直接访问本地 loopback 服务。若以后支持更强安全模型，可增加一次性 session token、Unix domain socket 或浏览器端 nonce。
- Trace 导出已经默认脱敏常见 secret/token pattern，但仍可能包含私有提示词、源码片段、文件路径、工具输出或业务数据；后续可增加导出前预览、风险扫描和可配置脱敏规则。
- `/api/view` 仍会加载选中会话的完整视图，这是“用户点开详情”时的预期行为；未来可继续拆成分页/lazy raw/tree endpoints。
- Markdown 渲染、翻译和 Raw JSON 展示应继续避免一次性渲染超大 DOM；新增展示区时要补大样本 fixture 或 smoke。
- 如果未来支持远程访问 dashboard，应设计成明确的远程模式，而不是简单开放 host：需要认证、CSRF token、CORS 策略、TLS/反代建议和更明确的隐私提示。

## 维护约定

- 修改捕获、代理、导入、Raw JSON、翻译缓存、daemon lifecycle、安装卸载和跨平台路径时，必须考虑安全边界和大 Trace 性能。
- 新增用户可见文案时，同步检查国际化文本。
- 重要改动后至少运行：

```bash
npm run smoke:security-boundary
npm run smoke:source-list-performance
npm run smoke:persistence-store
npm run smoke:trace-bundle
npm run smoke:dashboard-open
```

发布前运行：

```bash
npm run release:check
```
