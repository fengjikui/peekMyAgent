# Session Navigator View 契约

更新时间：2026-07-14

左侧 Session Navigator 负责把所有可见 Source 按 Agent 和项目组织起来，并提供选择、折叠及会话/项目动作入口。归档、删除、重命名、导入导出等应用副作用仍由 `client.js` 编排，Navigator 不直接访问 Viewer API。

## 模块边界

- `src/viewer/session-navigator-model.js`：将 SourceSummary 列表规范成 Agent、项目和 Session View DTO；统一跨平台工作目录名称、活动态、可用性、状态、菜单和数量文案。
- `src/viewer/session-navigator-renderer.js`：只根据 View DTO 生成导航 HTML，所有 Source 文本和标识符必须转义。
- `src/viewer/session-navigator-controller.js`：长期持有一次根事件委派、菜单状态和项目折叠偏好；通过回调请求应用层执行选择和数据动作。

`client.js` 只注入当前 sources/active source、i18n/格式化依赖，以及 `loadSource`、Source 动作和项目动作回调。Model/Renderer 不读取 DOM、网络、存储或全局 `state`；Controller 的 DOM 根、document target 和 storage 都通过构造参数注入。

## 稳定行为

- 同一 Agent、同一 workspace 的 Source 必须归入同一个项目；Windows 和 POSIX 路径都能生成正确项目名。
- 项目 identity 不依赖本地化显示文案，切换 UI 语言不得让未分配项目丢失菜单或折叠状态。
- 不可用 Source 保持可见但不可选择。
- 同时至多打开一个 Source 或项目菜单；点击导航外部关闭菜单。
- 项目折叠状态持久化到 `peekmyagent.collapsedProjects`，损坏或非对象存储值回退为空对象。
- 菜单、折叠、选择使用根事件委派，不因自动刷新或 UI 语言切换重复绑定监听器。
- Controller 只传递明确的 `{ action, source }` 或 `{ action, projectGroup }`；确认、API 更新、下载和错误提示属于应用编排层。

`scripts/session-navigator-view-contract-smoke.mjs` 直接覆盖跨平台分组、DTO、HTML 转义、不可用项、折叠持久化、菜单互斥、外部关闭、动作 payload 与监听器生命周期。Server 侧项目归档/删除的数据语义继续由 `scripts/project-source-actions-smoke.mjs` 覆盖。
