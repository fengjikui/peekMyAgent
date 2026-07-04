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
| 本地 dashboard API | 恶意网页通过浏览器向 `127.0.0.1` 发起读取、导出或状态修改请求 | 所有 API 拒绝跨站 `Origin` / `Referer` / Fetch Metadata，拒绝资源加载/页面导航形态的 API 请求，所有状态修改接口额外要求 JSON content-type |
| 远程暴露 | 用户误把 dashboard/proxy 绑定到 `0.0.0.0` | 默认拒绝非 loopback host；远程暴露必须显式 unsafe opt-in |
| Capture proxy | 被当成通用 SSRF/open proxy | 上游 URL 只允许 `http:` / `https:`，剥离 hop-by-hop、proxy 和内部 `x-peek-*` 头 |
| 大请求/导入包 | 请求体、gzip Trace、导入 captures 过大导致内存或 CPU 放大 | JSON body、captured request、Trace 压缩/解压大小和 capture 数量都有上限 |
| 文件路径 | 翻译语言、agent/cache slug、导入目录、OTel 扫描造成路径穿越或大目录扫描 | 语言名、agent/cache slug 和导入 Trace id 经过 path segment 归一化；导入目录强制留在 imports 根目录下；OTel 读取限制文件数、目录数和单文件大小 |
| 数据留存 | raw body 长期保存或导出泄露敏感内容 | README/隐私文档明确说明；SQLite store/WAL/SHM 和导入 Trace 文件使用私有权限；清理/卸载只把 store/registry 当作文件删除，不递归删除目录形态的误配置 store path；Trace 导出默认脱敏常见 secret/token pattern 和敏感字段名，并要求 dashboard 显式 intent header 触发下载 |
| 外部模型调用 | 翻译刷新误触发过高并发或过大材料集，放大用户 API 成本、触发限流或拖慢本机 | Dashboard 翻译接口和翻译脚本都限制最大并发为 100；翻译材料还限制条数、单块字符数和总字符数 |
| 内容渲染 | 模型回复、工具结果、翻译文本和 Markdown 表格携带 HTML/脚本片段 | Markdown 渲染器只允许受控标签，所有用户内容先转义；发布门禁覆盖 `<script>`、`<img onerror>`、`javascript:`、表格和代码块样本 |
| 同机恶意进程 | 本机其他进程直接访问本地端口 | 当前不把同机恶意进程视为完全可防边界；后续可考虑 session token/Unix socket |

## 已落地的安全修复

- `src/viewer/server.mjs`
  - 拒绝非 loopback 绑定，除非显式开启 unsafe remote。
  - 为本地 API 增加 `Origin` / `Referer` / Fetch Metadata 防护；包括 daemon shutdown 在内的所有状态修改接口额外要求 JSON content-type。
  - API 拒绝 `no-cors` 资源加载和 `document` 导航等浏览器资源型请求，避免恶意页面用图片、脚本或跳转形态诱导本地服务执行重活。
  - 为 dashboard、JSON API 和 Trace 导出统一增加基础浏览器安全响应头：`nosniff`、`no-referrer`、`COOP` 和限制脚本/对象/嵌入的 CSP。
  - 限制普通 JSON body、Trace 导入体积、gzip 解压体积和导入 capture 数量。
  - 翻译目标语言进入缓存路径前做安全归一化。
  - 导入 Trace 列表优先使用 manifest 统计，避免列会话时解析完整大文件。
  - 导入 Trace 的 `trace_id` 不允许通过 `.` / `..` 之类的全点段逃出 imports 目录；创建导入目录前还会校验最终路径必须位于 imports 根目录内。
  - 导入 Trace 的 manifest 标题进入 source list 前会去除控制字符、压缩空白并限制长度，避免共享包用异常标题污染侧边栏或放大渲染成本。
  - 导入 Trace 的 manifest 统计值和 source 元数据不被当作可信输入；计数会过滤非有限/负数并限制到安全整数范围，agent/workspace/conversation id 会去除控制字符、压缩空白并限长。
  - 删除导入 Trace 前校验目标目录必须位于 peekMyAgent imports 目录下。
  - Trace 导出包默认递归脱敏常见 token/API key 字符串；对 `api_key`、`password`、`token`、`cookie`、`secret`、`session_id` 等敏感字段名整值脱敏，并在 manifest 标记脱敏策略与隐私提示。
  - Trace 导出脱敏增加最大递归深度和节点预算，异常嵌套或恶意构造的数据会被显式标记为 redacted，而不是拖垮导出流程。
  - Trace 导出不再接受普通导航式 GET，必须由 dashboard fetch 带 `x-peekmyagent-intent: trace-export` 触发，降低外部网页诱导下载敏感 Trace 的风险。
  - Trace 导出必须显式指定已存在的 source id；缺失或未知 source 会返回 400/404，避免错误回退导出第一个会话。
  - `/api/view`、`/api/request` 和按 source 刷新的翻译生成只在未指定 source 时允许默认打开第一个会话；显式未知 source 会返回 404，避免误展示或误翻译另一个会话。
  - 翻译缓存查询和翻译刷新结果不向浏览器返回 `cache_path`、`materials_path`、`manifest_path` 这类本机绝对路径；前端只接收缓存状态、slug、条目数和翻译统计。
  - 翻译生成接口限制最大并发为 100，并限制单次材料条数、单块字符数和总字符数，避免误操作或恶意本地调用导致外部模型请求风暴或本机资源放大。
- `src/core/app-paths.mjs`
  - 底层 path segment 会移除全点段、首尾点/连字符，并规避 Windows 保留设备名；翻译缓存的 agent slug 不再保留点号，避免 `.` / `..` 形态影响目录层级。
- `src/viewer/markdown.js`
  - 模型回复、Messages 整理视图、工具/系统提示词翻译和子 Agent 结果共用同一个安全 Markdown 渲染器；该渲染器先转义文本，再只生成有限的段落、列表、标题、代码、表格和加粗标签。
- `src/viewer/server.mjs`
  - 会话重命名、source meta、持久化 watch title 和导入 Trace 标题进入 source list 前会统一去除控制字符、压缩空白并限制长度，避免异常标题污染侧边栏或拖累渲染。
- `src/core/persistence-store.mjs`
  - SQLite store 主文件和 WAL/SHM 边车文件在打开/关闭时尽量收紧到 `0600`，降低自定义 state/store 路径权限过宽时的 raw body 泄露风险。
- `scripts/translate-materials-zh.mjs`
  - 直接运行翻译脚本时同样限制最大并发为 100，避免绕过 dashboard API 的保护。
- `src/core/capture-proxy.mjs`
  - 限制捕获请求体大小。
  - 校验上游 URL 协议，只允许 `http:` / `https:`。
  - 过滤请求和响应里的 hop-by-hop/proxy/internal headers，包括 `Connection` 指定的额外逐跳头；捕获的响应头会脱敏后落盘。
- `src/core/otel-capture.mjs`
  - 限制 OTel 目录扫描规模和单个 JSON 文件大小。
- `bin/peekmyagent.mjs`
  - `shutdown/restart --force` 不再杀未知端口占用者，只允许清理 registry 中确认属于 peekMyAgent 的进程。
  - `clear --all-sessions` 和 `uninstall --remove-data` 删除 store/registry 这类文件型数据时拒绝目录形态路径，避免 `PEEKMYAGENT_STORE_PATH` 误设为目录后发生递归删除；目录型缓存只允许删除 stateDir 下固定子目录。
- `src/core/platform.mjs`
  - Windows 打开浏览器改用 `rundll32.exe url.dll,FileProtocolHandler`，避免 `cmd /c start` 的 shell 语义。

## 已落地的性能修复

- 左侧 live watch 列表直接使用 capture 轻量字段，不再为了列表构建完整 request timeline。
- 导入 Trace 列表优先读 manifest 统计，不在 `/api/sources` 解析完整 `proxy-captures.json`。
- Response Raw 默认展示最终解析结构和捕获元数据，不把 SSE/stream 原文整段下发到 viewer；大流式响应通过 `body_text_omitted` 标记保留可解释性。
- Compact 时间线不再携带完整 `complete_response` 或长 tool_use 参数；首页只保留响应/参数预览，点击 Raw/详情时再通过 `/api/request` 恢复完整内容。
- Compact 视图的上下文构成统计改用轻量字符估算，并缓存消息前缀比较 key，避免大 Trace 首页构建反复执行稳定 JSON 序列化。
- Compact 首屏进一步截短 system/assistant/internal preview、entry 文本和 response 重复预览，只保留时间线直接展示所需的 composition 分区；完整内容由 `/api/request` 单请求详情恢复。
- Compact 首屏不再携带 Raw headers、上游 response headers、重复的 `response.preview` 和完整 `context_delta.previews.command_message` 对象；真实 137 请求 Trace 的 compact payload 从约 2.16MB 降到约 1.54MB，合成 420 请求样本从约 4.58MB 降到约 3.90MB。
- Trace 导出直接读取 source 的 raw captures 并执行脱敏打包，不再先构建完整 viewer timeline，避免大 Trace 导出触发 turns、agent trace、context diff 等重计算。
- Raw JSON 搜索增加 debounce，减少大 JSON 下的连续重渲染。
- 切换/刷新视图时清理旧翻译 action 状态，避免长时间使用后积累无效 UI 状态。
- 重命名持久化到 SQLite/import manifest，刷新后不再恢复旧标题。
- SQLite 持久化会话在左侧列表推断标题时只读取前几条 capture 样本，并且用户手动标题优先于任何自动推断，避免大 Trace 因列表刷新触发全量加载或标题回退。
- `/api/request` 对 live watch、SQLite 持久化会话、导入 Trace 和静态 evidence 使用单条详情快路径，只加载目标请求附近的小窗口，不再为 Raw/System/Tools 详情点击重建整个大 Trace。
- 请求级翻译刷新带 `request_id` 时复用单条详情快路径，只抽取目标请求的翻译材料；只有整段刷新才加载完整 source。
- 长 Trace 主时间线超过阈值后只渲染当前 active turn 附近的窗口，Turn rail 仍保留全局跳转；1000 轮合成 Trace 的主时间线 DOM 从约 36k 节点降到约 2.8k 节点，总 DOM 约 4k。
- Raw Messages 的“整理”视图对单个文本块设置 Markdown 渲染上限，长文本只展示预览并提示切换原文查看完整 JSON，避免压缩摘要或长工具结果造成右侧面板卡顿。

## 新增/扩展的自动验证

- `npm run smoke:security-boundary`
  - 覆盖非 loopback 绑定拒绝、Trace 导出 intent 要求、跨站 API/Trace 导出拒绝、浏览器资源/导航形态 API 拒绝、非 JSON 状态修改拒绝、daemon shutdown JSON content-type 要求、基础安全响应头、不安全语言路径拒绝、不安全 agent slug 归一化、翻译材料规模拒绝、超大 Trace capture 数拒绝。
- `npm run smoke:platform`
  - 覆盖 macOS/Windows/Linux 路径、浏览器打开、子进程启动和 app path 构造；额外覆盖翻译缓存路径在 `.` / `..` 和 Windows 保留名输入下不会逃出 state translations 根目录。
- `npm run smoke:source-list-performance`
  - 构造一个 manifest-backed 大 Trace，故意让 `proxy-captures.json` 不可解析；同时构造 SQLite 通用标题会话并禁止 `loadCaptures()`；`/api/sources` 仍应能列出它们，防止会话列表退回全量解析慢路径或覆盖用户重命名标题。
- `npm run smoke:maintenance`
  - 覆盖 `clear --all-sessions`、`uninstall --remove-data` 和 helper 清理路径；额外覆盖目录形态 `PEEKMYAGENT_STORE_PATH` 必须被拒绝，防止误配置导致递归删除。
- `npm run smoke:persistence-store`
  - 覆盖会话重命名跨 viewer restart 持久化、SQLite store 文件私有权限，以及 `/api/request` 不走全量 persisted source 加载。
- `npm run smoke:source-meta`
  - 覆盖静态、live、OTel 和 stored source 标题持久化；额外覆盖先重命名、后由首个请求识别 conversation id 的真实使用边界。
- `npm run smoke:harness-translation`
  - 覆盖 Harness 提示词翻译、缓存命中、翻译并发上限，以及带 `request_id` 的请求级翻译刷新。
- `npm run smoke:platform`
  - 覆盖跨平台 browser opener 命令。
- `npm run smoke:package`
  - 覆盖 npm 包内容边界，拒绝把 `docs/`、`tmp/`、handover/private/resume/memory 草稿、`.env`、数据库、日志、压缩包和录屏/截图素材打进发布包。
- `npm run smoke:timeline-window`
  - 覆盖长 Trace 主时间线窗口渲染和 Raw Messages 整理视图截断，防止前端回退到大 DOM 全量渲染。
- `npm run smoke:markdown-safety`
  - 直接调用真实 Markdown 渲染模块，覆盖段落、加粗、代码块和表格中的 HTML/脚本样本，确保只输出受控标签和安全属性。
- `npm run smoke:compact-view-performance`
  - 构造 420 条包含大 system/tools/history/response 的合成 Trace，约束 `/api/view?compact=1` 首屏 payload、耗时和大字段省略行为，防止切会话路径回退到全量 Raw。
- `npm run smoke:trace-bundle`
  - 覆盖 Trace 导出默认脱敏、敏感字段名脱敏、导出脱敏深度保护、导入后只读查看、导入 Trace 的 `trace_id` 路径穿越防护、导入 Trace 的 `/api/request` 单请求窗口详情、删除导入 Trace 会移除对应本地导入目录，以及导出不读取完整 timeline companion 文件。

这些 smoke 已加入 `scripts/release-check.mjs` 的发布门禁。

## 剩余风险与后续建议

- 本机恶意进程仍可直接访问本地 loopback 服务。若以后支持更强安全模型，可增加一次性 session token、Unix domain socket 或浏览器端 nonce。
- Trace 导出已经默认脱敏常见 secret/token pattern，但仍可能包含私有提示词、源码片段、文件路径、工具输出或业务数据；后续可增加导出前预览、风险扫描和可配置脱敏规则。
- `/api/view` 仍会加载选中会话的完整 compact 视图，这是“用户点开详情”时的预期行为；未来可继续拆成真正分页的 turn endpoint，以及 lazy raw/tree endpoints。
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
