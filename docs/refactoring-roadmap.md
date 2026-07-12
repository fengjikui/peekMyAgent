# peekMyAgent 重构路线图

更新时间：2026-07-12

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
| 协议 | provenance 与 translation block 已有共享契约；其余 request/detail DTO 仍由 Server 和 Client 分别解释 | 字段漂移、展示歧义和重复修复 |
| 数据库 | 内容寻址和 migration runner 已落地；repository 仍集中在 `PersistenceStore` | 后续领域拆分仍受单体 store 约束 |
| 性能 | 首屏渐进、折叠区与搜索结果已按需生成；后台仍读取完整 compact Trace | 网络、解释和内存成本仍随会话线性上升 |
| 测试 | smoke 丰富，但基础设施重复，部分 UI 仅正则检查源码 | 维护成本高，真实交互回归覆盖不足 |
| 发布 | `0.0.0`、无稳定版本/变更记录流程 | 用户难判断兼容性，npm 发布不可追踪 |

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

当前进展（2026-07-12）：

- 已建立 provenance v1 最小运行时契约，先用于 OTel raw-body request/response，分离正文 fidelity 与关联 confidence。
- 已接入 Claude Code OTel body events，通过 `traceId + spanId` 精确关联 response，并保留旧版本顺序回退。
- 已建立 SQLite migration baseline：`PRAGMA user_version=1`、顺序事务 runner、旧库认领、未来版本保护和 schema shape 校验。
- 已建立共享 translation block contract：Server、Client、提取脚本和 worker 统一规范化、lookup key、schema description 和 marker 解析，缓存 hash 保持兼容。
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

当前进展（2026-07-12）：

- 已抽出 `src/server/http.mjs`，集中管理 method 表、loopback/Origin/Fetch Metadata 防护、Content-Type、intent、body parser、CSP 和 JSON/静态响应。
- 已增加不启动 daemon 的 HTTP contract smoke，并继续以真实 Viewer security smoke 锁定校验顺序和响应行为。
- 已建立 SourceRepository 最小契约，统一 live、SQLite、file/demo 与 imported Trace 的 provider 汇聚、DTO 校验和显式 source 解析；现有标题/统计 provider 尚未迁出单体。
- 已迁移 imported Trace provider：manifest 快速统计、旧 bundle fallback、目录发现与 DTO 构造不再由 Viewer Server 所有；共享 Source 文本约束保持标题清洗兼容。
- 已迁移 file/demo provider：custom evidence 与显式 demo 的定义、路径解析、可用性和统计开关不再由 Viewer Server 所有；默认仍不加载 demo。
- 下一步处理依赖 store 和 watch runtime 的 persisted/live provider。

## 阶段 3：拆分 Viewer Client

**目标：** 把数据获取、状态和视图更新从一个全局脚本中解耦。

建议顺序：

1. 抽出 API client 和 request-detail cache。
2. 建立最小 client store，明确 source、timeline window、selected request、language 和 pane layout。
3. 按 timeline、raw inspector、translation、agent graph、composer 拆 feature renderer。
4. 将硬编码文案移入中英文资源表；增加缺失 key 检查。
5. 删除确认无调用的函数和 CSS，再按 component/feature 拆样式。

验收：

- 选择 request、切换 Raw tab、翻译一个块不再默认触发整页 `renderAll`。
- 至少用真实浏览器测试三栏折叠/调整、时间线导航、Raw 懒展开和 Markdown。
- pane 宽度变化由单一布局模型控制，组件响应使用容器条件而非只看 viewport。

## 阶段 4：大 Trace 数据路径

**目标：** 让内存、网络和 DOM 成本与“当前可见窗口”相关，而不是与整条 Trace 相关。

任务：

- 增加 cursor/turn 分页 API，首屏后按滚动或导航增量加载。
- 客户端使用 normalized entity store 合并页面，不重新构建全部 Trace。
- Raw JSON 节点按展开状态懒创建；搜索建立可取消的后台索引。
- 对 file/import source 建 sidecar index，避免每次完整 parse。
- 把 system diff 改成有大小门限的算法，超限时使用 hash/块级摘要。
- response 更新只调整受影响 blob refcount；翻译缓存做批量/原子 flush。
- 增加浏览器性能 gate：首屏、长任务、DOM 节点、峰值内存和交互延迟。

验收建议：

- 1,500 request / 100 MiB Trace 首屏不依赖完整 Trace 传输。
- 打开 source 后，后台不自动下载全部 Raw response。
- 时间线滚动、选择 turn 和展开 Raw 没有可感知的长主线程阻塞。

## 阶段 5：适配器 SDK 与更多 Agent

**目标：** 新 Agent 通过稳定扩展点接入，而不是继续向 Server/Client 添加条件分支。

适配器最小契约：

- 配置发现与可逆 patch。
- capture source 和 provenance 声明。
- 协议标准化。
- session/conversation/subagent 身份提示。
- 能力声明：proxy、OTel、resume、composer、tool schema、thinking。
- fixture 和确定性 contract test。

完成这一步后，再按真实用户需求评估 Codex、OpenCode、Hermes 等适配优先级。

## 阶段 6：公开发布成熟度

任务：

- 建立 semver、CHANGELOG、release notes 和 npm provenance。
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
