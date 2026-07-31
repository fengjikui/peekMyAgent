# 分级测试与批次检查策略

更新时间：2026-07-31

这份策略解决两个同时存在的问题：每次小改都运行完整发布门禁会拖慢开发，而只在最后集中测试又会让回归范围失控。核心原则是：**每次改动立即获得与风险匹配的证据，低风险改动可以累计，但累计到固定阈值必须清零并运行全量检查。**

规范性要求以 [Coding Agent Collaboration Covenant](../AGENTS.md) 为准；本文解释如何在日常开发中执行。

## 执行前声明

开始测试前，开发者必须先给出一行可核对的判断，而不是先启动全量再解释：

```text
Validation level: Level 1
Changed boundary: Viewer request rail renderer only
Planned checks: node --check, smoke:request-rail-contract, one focused browser scenario
Escalation trigger: unexpected shared-contract failure or Level 1 counter reaches 3/3
```

Level 2 不是通用的“更放心”选项。只有命中高风险边界、累计阈值、共享/发布检查点，或聚焦测试暴露未知影响时才运行；否则聚焦证据通过后应停止测试并继续开发。

## 三个级别

| 级别 | 典型改动 | 当次必须完成 | 是否计入累计 |
| --- | --- | --- | --- |
| Level 0 | 纯文档、注释、非运行时治理文本 | `git diff --check`，以及对应文档/governance smoke | 否 |
| Level 1 | 单一纯函数、低耦合 renderer、窄范围回归修复 | 语法检查、直接契约测试、最近邻集成测试；交互变化补一条窄范围浏览器验证 | 是 |
| Level 2 | CLI、进程、平台、安装卸载、端口、Capture、OTel、数据库、导入导出、安全、工作流、包边界，或累计检查点 | Level 1 的聚焦证据，加一次 PR 托管三平台矩阵；仅在门禁自身变化、平台复现、无托管 CI 或未知影响时补本机完整 profile | 完成后清零 |

无法确定级别时向上取一级。测试失败且不能马上证明是测试环境问题时，也向上升级，不能用“改动看起来很小”继续累计。

## 累计规则

- 最近一次在当前分支精确树上通过本机或托管完整 profile 后，Level 1 计数从 0 开始。
- 每个包含运行时代码的 Level 1 提交加 1；Level 0 不计数。
- 第 3 个 Level 1 提交可以正常完成聚焦测试和提交，但在开始第 4 个代码提交或推送当前批次前，必须运行 Level 2。
- 高风险改动立即触发 Level 2，不等待计数达到 3；先完成聚焦测试，再由 PR 的 macOS、Windows、Linux 矩阵给出一次完整平台证据。
- 跨 Agent 交接、PR 和发布候选属于强制检查点。普通代码推送本身不再触发一遍本机全量；`main` merge 和 Release 也不重复已经通过的同树三平台矩阵。
- 完整 profile 只证明它实际测试的树。通过后又产生运行时代码变更，计数立即重新从 1 开始。Squash merge 产生新 SHA 时，只有确认 merge tree 与已验证 PR tree 字节一致才可复用证据，并同时记录两个 SHA。

## 推荐工作节奏

1. 修改前标记本次级别和最近的测试边界。
2. 先列出最小命令集合：通常是一条直接契约加一条最近邻集成；没有升级触发器就不扩大范围。
3. 每个小改完成后立即运行聚焦测试，保持提交职责单一。
4. 可以连续完成最多 3 个低风险代码提交，不必在每个提交后重复完整门禁。
5. 到阈值、高风险点或准备共享时，明确记录触发原因；门禁自身变化、平台复现或未知影响才在本机运行完整 profile。
6. 批次推送并创建 PR，用一次三平台 CI 验证候选树；merge 后只运行快速完整性检查，Release 只验证精确 Tag/包/OIDC。
7. 真实浏览器或真实 Agent 暴露出的稳定不变量，应提炼成确定性 smoke，减少以后手工重复劳动。

## 示例

### 可以累计

- 提取一个无副作用的 Viewer HTML renderer，并有直接契约测试。
- 把一个事件绑定器拆成 controller，补绑定次数和事件路由 smoke。
- 修复一个局部搜索高亮问题，并在一条真实 Trace 上完成窄范围浏览器验证。

这三项可以各自提交。第三项完成后，在继续下一项前进入 Level 2；若马上创建 PR，可由托管三平台矩阵完成完整检查点，不必先重复一遍本机全量。

### 不应累计

- 修改 `pma claude` 的进程生命周期。
- 修改 SQLite schema 或迁移。
- 修改代理监听地址、请求安全校验或 Trace 导入清理。
- 修改 npm 安装、全局命令或卸载。

这些改动即使代码行数很少，也直接进入 Level 2。

## 记录方式

开发更新或交接报告应简要写明：

```text
Validation level: Level 1
Focused checks: smoke:example, browser scenario X
Level 1 counter: 2/3 since <tested SHA>
Next mandatory full checkpoint: pull-request matrix or before the fourth Level 1 code commit
```

完整检查报告必须继续写明精确 SHA、主机环境、命令和退出码。复用 squash merge 的证据时还要记录已验证 PR SHA、merge SHA 与 tree identity 检查；不要使用“最新代码已通过”这种无法复现的表述。
