# peekMyAgent 重构路线图

更新时间：2026-07-15

这份路线图的目标不是“大改得更漂亮”，而是在不破坏现有用户闭环的前提下，让 peekMyAgent 能长期演进、方便外部贡献，并为更多 Agent 适配建立稳定边界。当前系统事实见 [架构文档](architecture.md)。

## 重构原则

1. **先冻结行为，再移动代码。** 每个拆分 PR 必须先有或补上行为 smoke。
2. **按职责和数据所有权拆分。** 不以“每个文件少于多少行”为目标。
3. **先共享契约，再拆前后端。** 否则只是把重复逻辑搬进更多文件。
4. **一次只替换一条调用路径。** 保留旧实现作为短期对照，验证后再删除。
5. **来源事实和推断结果分开。** 原始证据、标准化字段、启发式关联必须可追溯。
6. **跨平台是持续约束。** 路径、进程、shell、权限和安装行为都要通过三平台 gate。
7. **文档与代码同 PR 更新。** 架构、用户文档和 Roadmap 不允许长期滞后。

## 当前主要债务

| 领域 | 现状 | 影响 |
| --- | --- | --- |
| Server | `src/viewer/server.mjs` 同时负责 HTTP、安全、repository、Trace domain、翻译、bundle 和 Agent send | 很难局部测试和分配代码所有权 |
| Client | `src/viewer/client.js` 同时负责 store、fetch、协议解释和所有视图 | 小交互容易触发全量渲染，贡献者难定位 |
| CLI | `bin/peekmyagent.mjs` 包含命令解析和几乎全部命令实现 | 新命令继续扩大入口文件，wrapper 生命周期难单测 |
| 协议 | provenance、translation block、`SourceSummary`、单请求 `TraceRequestDetail` 与完整/compact/cursor Timeline envelope 已有共享契约；其余 operation 响应仍由各层分别解释 | 高频读取 DTO 已阻断漂移，写操作与控制面接口仍需按功能逐条迁移 |
| 数据库 | 内容寻址和 migration runner 已落地；Capture 读取 repository 已抽离，Watch/Capture 写入、维护与连接生命周期仍集中在 `PersistenceStore` | 写路径继续受单体 store 约束，但读取查询和水合已有独立可测边界 |
| 性能 | live/SQLite/file/import 已使用 cursor 增量读取和实体 delta；文件后端使用私有 sidecar byte range；System diff 已有精确门限和块级退化；Client/Server 仍累计 compact 实体 | 首屏网络、文件 hydrate 和大 System diff 成本已受控，但超长会话的常驻 compact 实体仍随会话增长 |
| 测试 | smoke 丰富，但基础设施重复，部分 UI 仅正则检查源码 | 维护成本高，真实交互回归覆盖不足 |
| 发布 | `0.1.0-alpha.1`、锁文件、CHANGELOG 和精确 Tag 三平台/OIDC 发布工作流已建立；首次 npm 包实体和候选 SHA 实机验证尚未完成 | 自动化边界已清晰，首次公开发布仍需维护者引导和三平台证据 |

## 公开 Alpha 前的重构收口

结构重构不再以“拆完所有大文件”为目标。公开 alpha 前只继续处理会直接影响数据完整性、关键交互回归或新贡献者定位的问题：

- 修正文档入口和真实模块路径，保证新贡献者可以从任务定位到唯一边界与最小测试。
- 已为迟到 response 的 content blob、关联、refcount、Capture JSON 和 watch 时间补齐单事务写入与 failure-trigger 回滚契约；后续写路径修改必须保持该边界。
- 已为 Raw 搜索建立隔离 Viewer/Capture Proxy + 真实 Chromium/Edge 的发布门禁，覆盖中文 IME、长文本尾部命中、可见计数、高亮、循环导航、区块切换和粘性控件；Claude wrapper 发布门禁覆盖正常/非零退出、幂等 watch 清理，并在 POSIX 主机覆盖 `Ctrl+C` 转发、退出码和停止状态。Windows 控制台事件继续保留真实机器发布验证。
- 已完成 semver、锁文件、CHANGELOG、预发布 dist-tag 和 npm OIDC/provenance 工作流；首次 npm 包实体、GitHub Environment 与最终候选 SHA 三平台验证留在发布检查点完成。

以下工作移到公开 alpha 后，由真实问题或新增功能触发：继续机械拆分 `server.mjs`/`client.js`、完整 Write Repository 抽离、Claude wrapper 全面模块化、page eviction、后台搜索索引、前端框架替换和 Adapter SDK 扩张。

阶段性完成标准是：贡献者能在十分钟内找到所有权和聚焦测试；高风险路径有确定性回滚/清理契约；当前候选 SHA 通过三平台发布门禁。文件行数本身不是验收指标。

## 目标模块形态

以下是方向，不要求一次创建所有目录：

```text
src/
  cli/
    main.mjs
    commands/
    runtime/
  capture/
    proxy.mjs
    otel.mjs
    provenance.mjs
  persistence/
    store.mjs
    migrations/
    repositories/
  protocols/
    anthropic.mjs
    openai-responses.mjs
    common.mjs
  trace/
    model.mjs
    context-delta.mjs
    tool-exchange.mjs
    subagents.mjs
  server/
    http.mjs
    routes/
    services/
  translation/
    blocks.mjs
    cache.mjs
    providers/
  viewer/
    data/
    features/
    components/
    styles/
```

模块应通过明确 DTO 连接，而不是跨目录读取对方内部状态。

## 阶段 0：建立可信基线

**目标：** 在结构调整前，让“当前行为是什么”可以被机器和文档同时证明。

任务：

- 校正文档中的已实现/规划状态，特别是 demo 默认加载、Trace 脱敏、保留策略和术语。
- 为数据来源建立统一矩阵：capture mode、原始来源、关联方式、置信度、可能丢失字段。
- 给关键端到端流程补 fixture：普通消息、工具循环、compact、resume、并行子 Agent、OpenClaw。
- 明确 package 版本和首个公开 alpha 的兼容性承诺。
- 将 release gate 的耗时和平台覆盖写入发布 checklist。

验收：

- README、用户指南、Roadmap 与当前 CLI/help/API 行为一致。
- 每种 source 都能说明哪些字段是原始证据、哪些是派生或推断。
- `npm run release:check` 在干净工作树和三平台 CI 通过。

## 阶段 1：共享契约与数据库迁移

**目标：** 建立后续拆分都依赖的稳定地基。

任务：

- 定义 `CaptureRecord`、`SourceSummary`、`TraceRequestDetail`、`Provenance`、`Confidence` 的运行时 schema 和版本。
- 让 Anthropic、OpenAI Responses、OTel/OpenClaw normalizer 输出同一中间模型。
- 合并翻译块提取、规范化和 hash key 生成，Server/Client/脚本共用。
- 引入 `PRAGMA user_version` 和顺序 migration runner；先添加不改变 schema 的 baseline migration。
- 为 JSON API 增加 contract smoke，检查字段和版本，不只检查页面文字。

验收：

- Viewer 不再需要针对同一协议维护第二套字段提取。
- 老数据库自动打开，新数据库记录明确 schema version。
- 同一翻译块在脚本、Server 和 Client 中得到相同 key。

当前进展（2026-07-14）：

- 已建立 provenance v1 最小运行时契约，先用于 OTel raw-body request/response，分离正文 fidelity 与关联 confidence。
- 已接入 Claude Code OTel body events，通过 `traceId + spanId` 精确关联 response，并保留旧版本顺序回退。
- 已建立 SQLite migration baseline：`PRAGMA user_version=1`、顺序事务 runner、旧库认领、未来版本保护和 schema shape 校验。
- 已抽离 `SqliteCaptureReadRepository`：完整/首屏/分页/单请求窗口、request tree 重建和 response blob 水合不再由单体 `PersistenceStore` 实现；Store 保留兼容 facade，连接、migration、写事务和 GC 所有权不变。
- 已建立共享 translation block contract：Server、Client、提取脚本和 worker 统一规范化、lookup key、schema description 和 marker 解析，缓存 hash 保持兼容。
- 已建立共享 request translation material projector：System parts、Tools schema descriptions 与 Harness 注入只提取一次，Node Collector 与浏览器展示复用同一纯模块；服务端继续独占 hash、occurrence、限额和缓存写入。
- 已建立共享 Viewer API DTO contract：`SourceSummary` 与单请求 `TraceRequestDetail` 具有版本、运行时 schema 和 Node/浏览器双端断言，SourceRepository、Viewer Server 与 API Client 共用同一事实源。
- 已将 provenance v1 接入 Capture Proxy、OpenClaw normalizer 和 portable Trace import：区分 artifact fidelity 与关联 confidence，保留合法原始来源，旧导入采用保守回退。
- file/demo/debug 等尚未形成 CaptureRecord 的 source 仍需在后续 source repository 阶段建立统一 DTO；阶段 1 的共享地基已经完成，可以进入 Viewer Server 拆分。

## 阶段 2：拆分 Viewer Server

**目标：** 将 HTTP 门面与业务领域分开，不改变 API 行为。

建议顺序：

1. 抽出 HTTP guard、body parser、intent/method 校验。
2. 抽出 source repository，统一 SQLite、file、demo、import source 的读取接口。
3. 抽出 Trace domain：context delta、tool exchange、turn、subagent。
4. 抽出 translation service 和 bundle service。
5. 最后让 `server.mjs` 只负责组装依赖、注册路由和生命周期。

验收：

- 每个 service 可以不启动 HTTP server 直接单测。
- Server route 只做输入校验、调用 service 和序列化输出。
- 所有现有安全 smoke 与 Trace fixture 输出不变。

当前进展（2026-07-14）：

- 已抽出 `src/server/http.mjs`，集中管理 method 表、loopback/Origin/Fetch Metadata 防护、Content-Type、intent、body parser、CSP 和 JSON/静态响应。
- 已增加不启动 daemon 的 HTTP contract smoke，并继续以真实 Viewer security smoke 锁定校验顺序和响应行为。
- 已抽出共享 Viewer API contract 和依赖注入的 `ViewerRouter`：19 条 API 的 pathname/method、lookup/分页上限、`SourceSummary`/单请求详情 DTO、transport 校验、body 解析和响应序列化不再由 `server.mjs` 内联分发；直接 DTO/Router contract 与真实 security smoke 共同锁定字段、路由覆盖和校验顺序。
- 已建立 SourceRepository 最小契约，统一 live、SQLite、file/demo 与 imported Trace 的 provider 汇聚、DTO 校验和显式 source 解析；现有标题/统计 provider 尚未迁出单体。
- 已迁移 imported Trace provider：manifest 快速统计、旧 bundle fallback、目录发现与 DTO 构造不再由 Viewer Server 所有；共享 Source 文本约束保持标题清洗兼容。
- 已迁移 file/demo provider：custom evidence 与显式 demo 的定义、路径解析、可用性和统计开关不再由 Viewer Server 所有；默认仍不加载 demo。
- 已迁移 persisted provider：SQLite source 与 live watch 去重、手动/存储/conversation/inferred 标题优先级由独立 provider 管理，消息语义通过 title policy 注入。
- 已迁移 live provider：watch runtime 与 SourceSummary 映射分离，请求/回复/子 Agent/Raw/last_seen 统计由独立 provider 管理，标题语义通过单一策略注入。
- 已迁移 Source metadata 与 lifecycle：稳定别名、原子 sidecar、title/pin/hidden 装饰以及 rename/archive/delete/project 编排由独立模块管理，Viewer 路由只读取输入并装配端口。
- 已建立统一 SourceCaptureReader：live/SQLite/file 的首屏、单请求窗口和 raw export 走同一协议；SQLite detail 与 export 快速路径由回归测试锁定。
- 已开始拆 Trace domain：消息等价与 Context Delta 已独立，主/子 Agent context chain、fixed-context 变化和本轮工具事件由直接契约覆盖。
- 已迁移 Turn Timeline：用户轮次边界、内部请求暂存以及工具/context 统计由独立模块管理，避免子 Agent 或 metadata 产生幽灵 Turn。
- 已迁移 Subagent Graph：Header 强实例关联、OTel prompt 回配、spawn/return 配对、分支步骤和 Turn 归属由独立 Trace Domain 管理。
- 已迁移模型下行回复归一化：Anthropic/OpenAI-compatible JSON/SSE 的 text、thinking、分片 tool use、usage 与 stop reason 由独立 Trace Domain 模块组装为统一 DTO，Viewer Server 不再拥有 provider-specific response parser。
- 已建立 Trace Content Parts 原语层：上行与下行共用可见文本、thinking、Anthropic/OpenAI tool call 和 tool result 提取，避免协议块解释分叉。
- 已迁移 Trace 消息语义：真实用户输入、slash command、compact/Skill/framework/suggestion 注入、混合工具结果与 task notification 由单一纯模块解释，Turn、标题和翻译层复用显式端口。
- 已迁移 Trace 请求画像：System 位置、Anthropic/OpenAI/Gemini 协议、provider/reasoning 扩展及 main/subagent/parent-spawn/metadata 来源提示由单一纯模块解释；metadata 优先级与 provenance 概念边界由直接契约锁定。
- 已迁移 Trace 请求构成分析：System、Tools、参数、历史消息、当前用户、工具交互及回复规模由纯模块输出兼容 DTO；字符近似、包含关系与上/下行展示边界由直接契约说明。
- 已迁移 Timeline 轻量投影：完整 Viewer Trace DTO 到 compact 首屏/时间线 DTO 的截断、Raw/Response 省略和遗漏计数由独立纯模块管理；HTTP route 只选择完整或 compact 表示，直接契约与大 Trace 性能 smoke 共同锁定边界。
- 已迁移 Viewer Trace 投影：Capture 到 request/Turn/Agent graph/stats/workbench DTO 的组合成为无 I/O `ViewerTraceProjector`；完整加载、单请求详情和 cursor 分页共享同一组消息、Context Delta、Turn、子 Agent 与 response 语义端口，HTTP route 不再拥有该组装实现。
- 已迁移 Trace Bundle Service：Raw 快路径导出、递归脱敏、gzip/数量边界、provenance 补全与安全导入目录由独立服务管理。
- 已建立共享 Translation Material Collector：Viewer 局部/整段刷新与离线提取统一使用 system/tool/schema hash、去重、occurrence 和限额协议。
- 已迁移 Translation Service：材料/manifest 私有落盘、缓存 alias、并发/force 参数、脚本编排和公开响应边界不再由 Viewer Server 所有。
- 已迁移 Viewer Translation Adapter：整条 Source/单 Request/显式材料刷新、occurrence 和 Harness 注入提取通过同步数据端口组装，Viewer Server 不再拥有翻译材料语义或 message marker。
- 已迁移 OTel Ingest Service：每 watch 事件缓冲、incremental/final 配对策略、连续 request index、watch DTO 和迟到 response 幂等更新不再由 Viewer Server 所有；纯事件/文件解析继续留在 `core/otel-*`。
- 已迁移 Agent Send Service：页面消息限制、Claude/OpenClaw detached 命令、workspace 回退、跨平台进程执行、诊断参数脱敏和临时 settings 清理不再由 Viewer Server 所有；active/persisted watch 恢复继续通过显式端口注入。
- 已迁移 Watch Runtime Service：active registry、new/reuse/restore、pause/resume/stop、共享/独立代理、稳定 Agent route、Capture 回调和幂等关闭不再由 Viewer Server 所有；Source Reader/Lifecycle 与 Agent Send 通过窄 runtime 端口协作。
- Watch 生命周期扩展字段持久化、persisted-only 控制面、shared per-watch cache 清理和大 watch 流式恢复仍需独立 schema/proxy 协议阶段，不属于本次抽离的已实现行为。
- 已迁移首个 Viewer Client feature：Turn Rail 的窗口策略、悬停、点击跳转和滚动激活由独立控制器管理，并有直接契约测试。
- 已建立 Viewer API Client：source/view/request/translation/import/export/send/watch 的浏览器协议与错误处理不再散落在全局脚本。
- 已建立共享 Viewer API 读取 DTO：SourceSummary、单请求窗口以及完整/compact/cursor Timeline 的身份、信封和分页不变量在 Server 序列化前与 API Client 解析后双向执行；领域实体内部字段继续由 Trace Domain 和 normalized Store 所有。
- 已迁移 request-detail cache：compact request 的详情判定、并发去重、错误重试和 source 生命周期由独立对象管理。
- 已建立 Raw Inspector View Model：上行请求、下行 Response、Harness 和 Metadata 的方向约束由纯模块统一。
- 已迁移 Raw Search Model：递归条目、过滤、摘要命中分段和循环导航索引不再依赖 DOM 或全局状态。
- 已迁移 Raw Search Controller：查询、IME 组合态、延迟重绘、清空、当前命中和滚动高亮不再由全局 client state 所有。
- 已迁移 Raw Inspector 基础 Renderer：请求/响应导航、搜索控件与结果、详情状态和来源提示只依赖显式 DTO 与渲染依赖。
- 已迁移 Message View Model 与 Renderer：role/content/block 规范化、结构化判定、长文本截断、原文/整理切换与安全 Markdown 不再由全局 client 所有。
- 已迁移 Translation View Model 与 Renderer：工具分组、译文搜索排序、命中统计、System/Harness 块、工具说明与参数汇总不再直接读取全局 client state；缓存 key 继续复用共享 translation block contract，动作注册通过显式依赖留在应用层。
- 最小 client store 已建立：source/Turn/request selection、Raw/messages mode、UI/翻译语言、pane layout 与 latest-only 已有单一写入边界和原子变更通知；大 Trace cursor、Client entity store 与 file/imported sidecar 已在阶段 4 落地，page eviction/细粒度订阅继续演进。
- 已迁移 Trace Timeline View Model：查询分类、命中 Turn、结果上限、latest-only、lead request 与窗口策略成为无 DOM 纯模块；Header、Timeline、Composer 已形成局部渲染表面，Timeline 内部交互和 Thinking 块翻译不再默认触发整页 `renderAll()`，活动选择由 Store 通知统一同步 DOM。
- 已迁移 Trace Timeline Renderer/Controller：查询、空状态和窗口 HTML 使用显式 DTO；IME、筛选、Raw/Agent 动作和活动态通过长生命周期控制器做单次事件委派，不再在每次 Timeline 重绘后逐按钮重新绑定。
- 已迁移 Request Card Renderer：请求卡外壳、上行标题与快捷动作、当前工具交换、Thinking 和 Assistant 回复 HTML 只消费显式 View DTO；详情读取、请求分类、翻译动作注册和响应折叠状态继续由应用层所有。
- 已迁移 Agent Graph View：Turn 内分支选择、稳定编号/颜色、状态筛选、分页和交错事件流成为纯 View Model；看板 HTML 成为纯 Renderer，展开/跳转等动作仍由 Timeline Controller 和应用状态所有。
- 已迁移 Upstream Detail View：System/Tools、历史消息、当前新增消息/子 Agent 回流和 provider token 口径成为纯 View Model；上行详情 HTML 成为纯 Renderer，compact detail 懒加载、缓存与展开状态仍由应用层所有；同时删除已无调用方的旧 context/badge/structure 渲染分支。
- 已迁移 Agent Composer View：source 能力、发送目标/警示与结果文案成为纯 View Model，表单成为纯 Renderer；长生命周期 Controller 按 source 隔离草稿和发送状态，并管理 Enter/IME、detached resume 与 source 刷新，不再依赖全局 client state 或逐次事件绑定。
- 已迁移 Session Navigator View：Source 的 Agent/项目分组、跨平台项目名、活动/可用状态成为纯 View Model，项目组和会话菜单成为纯 Renderer；长生命周期 Controller 管理根事件委派、菜单互斥和折叠持久化，归档/删除等副作用继续由应用层编排。
- 已迁移 Viewer UI i18n 资源：中英文词典、默认语言、fallback 与占位符插值从 `client.js` 抽为纯模块；新增键集合、占位符、静态引用、发布文件和浏览器资源契约。
- 已迁移 Pane Layout：三栏几何约束和内容占比成为纯 Model，折叠、偏好、ARIA、键盘/指针拖动和窗口变化由长生命周期 Controller 管理；Store 继续拥有布局状态，应用层只注入写入与重绘端口。

## 阶段 3：拆分 Viewer Client

**目标：** 把数据获取、状态和视图更新从一个全局脚本中解耦。

建议顺序：

1. 抽出低耦合交互 feature，验证依赖注入和直接契约测试模式。Turn Rail 已完成。
2. 抽出 API client 和 request-detail cache。已完成。
3. 建立最小 client store，明确 source、timeline window、selected request、language 和 pane layout。核心选择/偏好已迁移；阶段 4 已增加 `TimelineEntityStore` 持有 request/Turn/Agent normalized map，page eviction 与细粒度订阅仍待完成。
4. 按 timeline、raw inspector、translation、agent graph、composer 拆 feature renderer。
5. 将硬编码文案移入中英文资源表；增加缺失 key 检查。已完成现有 357 个 UI key 的资源迁移和契约门禁，后续 feature 继续复用该资源。
6. 删除确认无调用的函数和 CSS，再按 component/feature 拆样式。

当前进展（2026-07-14）：

- 已抽出 `RawInspectorController`：request/section/mode 选择、右栏打开、compact detail 懒加载、loading/error/content 提交与搜索装饰由单一生命周期控制器串联。
- Raw 异步渲染增加 operation id 与 Store context 双重失效检查，快速切换请求或区块时，旧详情和旧错误不能覆盖当前面板。
- 已抽出 `TranslationCacheController`：Source/目标语言缓存身份、Agent 候选探测、lookup dirty 重建、自动刷新 timer/attempt 去重和异步失效成为独立生命周期；request detail 即使在 hash 计算期间补载也会在提交前重算，生成副作用通过 operation token 拒绝旧 Source/语言，旧上下文结果不能覆盖当前缓存或 UI。
- 已抽出 `TranslationActionController` 与纯 Action Model：翻译生成、块/整段复制、工具参数整组重译、action registry 和 Source/语言切换后的 stale 副作用拒绝通过显式端口协作；剪贴板格式与完成文案不再由 `client.js` 所有，Cache Controller、Renderer 和搜索 Controller 仍保持独立。
- 已抽出翻译语言目录与 `LanguagePreferencesController`：完整目标语言 catalog、alias/系统语言推荐、偏好水合与持久化、选择器绑定、静态 i18n 和切换副作用顺序不再散落在 `client.js`；Cache/Action/Renderer/Raw 搜索仍保持各自边界。
- 已抽出 `ActiveSourceController`：Source catalog、首屏与后台 page、live polling、snapshot 翻译、catalog version 和 token-gated UI continuation 形成应用级生命周期；`SourceTimelineController` 仍独占 generation/cursor/normalized store，DOM/selection/URL/滚动仍由装配端口所有。
- 已抽出 `request-card-model.js`：请求身份、上行类别/标签/预览、快捷 section、工具事件配对和 Assistant response metadata/折叠成为可直接验证的纯 View Model；`client.js` 只注入当前展开状态、格式化依赖和 Thinking 翻译动作，`request-card-renderer.js` 只生成安全 HTML。

验收：

- 选择 request、切换 Raw tab、翻译一个块不再默认触发整页 `renderAll`。
- 已将 Raw 搜索中文 IME、完整值命中、可见计数、循环导航和粘性控件纳入真实 Chromium/Edge 发布 smoke；三栏折叠/调整、时间线导航、Raw 懒展开和 Markdown 仍需继续补齐真实浏览器场景。
- pane 宽度变化由单一布局模型控制，组件响应使用容器条件而非只看 viewport。

## 阶段 4：大 Trace 数据路径

**目标：** 让内存、网络和 DOM 成本与“当前可见窗口”相关，而不是与整条 Trace 相关。

任务：

- 增加 cursor/turn 分页 API，首屏后按滚动或导航增量加载。
- 客户端使用 normalized entity store 合并页面，不重新构建全部 Trace。
- Raw JSON 节点按展开状态懒创建；搜索建立可取消的后台索引。
- 对 file/import source 建 sidecar index，避免每次完整 parse。已完成 object boundary sidecar、指纹失效、私有原子缓存和请求窗口回退。
- 把 system diff 改成有大小门限的算法，超限时使用 hash/块级摘要。
- response 更新只调整受影响 blob refcount；翻译缓存做批量/原子 flush。
- 增加浏览器性能 gate：首屏、长任务、DOM 节点、峰值内存和交互延迟。

验收建议：

- 1,500 request / 100 MiB Trace 首屏不依赖完整 Trace 传输。
- 打开 source 后，后台不自动下载全部 Raw response。
- 时间线滚动、选择 turn 和展开 Raw 没有可感知的长主线程阻塞。

当前进展（2026-07-14）：

- 已建立 `SourceCaptureReader.readPage` 和 SQLite `loadCapturePage`，live/SQLite 只 hydrate 当前 capture 页面；file/import 通过 `JsonArrayFileIndex` 按对象 byte range 读取，原始 Trace 保持只读。
- 已建立 daemon 内存中的 Source 绑定 opaque cursor，包含 TTL、session 上限、错源/过期错误和 live tail 续读；Source 生命周期变更会清理 session。
- Context Delta 与 body-only 子 Agent lineage 已支持显式跨页状态，不再错误地按全局上一行比较或丢失早页 spawn。
- 已建立 `TimelinePageAssembler`：首屏返回 compact 基线，后续只返回 request patch、Turn entity update 和 Agent graph entity delta。
- Client 已由持久的 `TimelineEntityStore` 按稳定 id 管理 request/Turn/Agent map，页面合并不再从完整数组重建临时 map；完整 detail 覆盖也统一经过该边界。大 Source 首屏后不再请求完整 compact Trace，live 自动刷新优先从 refresh cursor 续读。
- Source 加载、progressive cursor、live refresh、过期回建和 normalized Store 已由 `SourceTimelineController` 统一管理 generation 与提交；旧 Source/page 不再能迟到覆盖，后台续读与自动刷新不再并发写同一个 Store，Viewer 应用层只保留 DOM、选择、滚动、URL 和翻译副作用。边界见 [Source Timeline Controller 契约](source-timeline-controller-contract.md)。
- 420-request 性能 fixture 已验证分页覆盖所有请求、Client normalized merge、累计网络载荷保持线性；真实 HTTP smoke 覆盖跨页父/子 Agent/回流和 live 增量。
- System diff 已迁移为纯 Model/Renderer：小输入运行有矩阵/字符上限的精确行级 LCS，大输入退化为共同前后缀加至多 256 个动态内容块的指纹摘要，不再在主线程创建无界二维数组。
- 尚未完成 page eviction/细粒度订阅、可取消文件/搜索读取、持久化 deep-link identity、增量 blob refcount 和浏览器内存/长任务 gate，因此阶段 4 仍保持进行中。

## 阶段 5：适配器 SDK 与更多 Agent

**目标：** 新 Agent 通过稳定扩展点接入，而不是继续向 Server/Client 添加条件分支。

适配器最小契约：

- 配置发现与可逆 patch。
- capture source 和 provenance 声明。
- 协议标准化。
- session/conversation/subagent 身份提示。
- 能力声明：proxy、OTel、resume、composer、tool schema、thinking。
- Harness 注入面声明：System、`<system-reminder>`、项目 memory、Skill 和 hook 内容必须记录其在已捕获 request 中的真实位置与证据来源。项目 memory 的具体注入时机属于 Claude Code 运行时行为，不再作为近期产品实验；[手动集成矩阵](manual-integration-smoke-matrix.md#claude-code-project-memory-injection-check)仅保留为版本差异或缺失问题的可选诊断流程，产品不承诺固定注入位置。
- fixture 和确定性 contract test。

Codex Desktop 已完成第一轮真实环境研究，结论见 [Codex Desktop 捕获研究与实施路线](codex-desktop-capture-research.md)：

- 桌面图标启动不是捕获障碍；默认 adapter 可只读 `$CODEX_HOME` 的 thread catalog、spawn edges 和 rollout JSONL，形成不修改配置的本地语义 Trace。
- OTel 可选增强时序、API/WebSocket 和工具决策，但不能替代完整请求捕获。
- 显式 `openai_base_url` 深度代理可观察 zstd request、模型可见输入和 `additional_tools` schema，但会经过认证与完整上下文，必须作为高风险 opt-in。
- 自建 app-server 适合未来托管模式，不能透明附着到用户已经打开的 Desktop app-server。

因此适配优先级暂定为：先完成 Codex Desktop 本地观察 Phase 1，再根据真实用户反馈决定 OTel/深度代理；OpenCode、Hermes 等继续等待适配器契约稳定。

## 阶段 6：公开发布成熟度

任务：

- 已建立 semver、锁文件、CHANGELOG、精确 Release Tag 三平台门禁、`next`/`latest` 分流和无长期 Token 的 npm OIDC/provenance 工作流；首次包实体仍需按[发布手册](releasing.md)引导创建。
- 提供可诊断、可回滚的用户更新入口；`pma update` 的行为必须区分 npm 全局安装、源码开发和不受管理的安装方式，并通过三平台安装生命周期测试。
- 在英文与简体中文 README 稳定后，按真实用户覆盖补充少量常见语言 README；所有版本共享同一安装、快速开始和 Agent 可读说明，并建立链接/命令漂移检查。
- 给 archive 增加历史列表和恢复入口；实现明确的 retention 设置后再宣称默认策略。
- 增加导出前风险预览和可配置脱敏。
- 评估本机 session token、Unix socket/Named Pipe 或一次性控制令牌，以加强同机边界。
- 完善贡献者开发命令、模块 ownership 和 ADR 模板。

## 建议的前三个重构 PR

### PR 1：数据库 migration baseline

- **已完成（2026-07-12）。**
- 引入 schema version、migration runner 和升级 smoke，不改现有表结构和产品行为。
- 新库、旧库、幂等打开、失败回滚和未来版本拒绝均有确定性覆盖。

### PR 2：共享 translation block key

- **已完成（2026-07-12）。**
- 抽出跨浏览器/Node 的规范化、lookup key、schema description、marker，以及 Node SHA-256 纯函数。
- Server、Client、提取脚本和翻译 worker 使用同一 contract fixture，旧缓存无需迁移。

### PR 3：扩展 Trace provenance DTO

- 将已经用于 OTel 的 provenance v1 扩展到 proxy、file、debug/event 和其他 heuristic association。
- 先在 detail/API 中暴露，不立刻重做 UI。
- 为后续协议 normalizer 和多 Agent 展示打基础。

## 暂不优先

- 在共享协议层完成前大量接入新 Agent。
- 一次性改写前端框架或引入大型依赖栈。
- 为追求文件行数而机械拆分。
- 在没有真实 PTY 需求验证前把 dashboard composer 改造成终端代理。
- 在没有实现设置和清理任务前宣称自动保留/自动清理策略。

## 文档同步机制

每个功能或重构 PR 的 checklist 应包含：

- [ ] 当前行为是否改变，是否更新用户指南。
- [ ] 数据结构/API 是否改变，是否更新架构和 migration。
- [ ] 新增/修改文案是否同步中英文和国际化 key。
- [ ] source/capture 语义是否改变，是否更新 provenance。
- [ ] Roadmap 中对应事项是否从计划移动为已实现。
- [ ] 是否增加或调整 deterministic smoke 和手动集成测试。

架构文档描述“现在是什么”，本路线图描述“准备怎么变”，历史实验和决策理由放在独立审计/ADR 文档。三类内容不要混写。
