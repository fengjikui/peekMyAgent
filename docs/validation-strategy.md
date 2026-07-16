# 分级测试与批次检查策略

更新时间：2026-07-13

这份策略解决两个同时存在的问题：每次小改都运行完整发布门禁会拖慢开发，而只在最后集中测试又会让回归范围失控。核心原则是：**每次改动立即获得与风险匹配的证据，低风险改动可以累计，但累计到固定阈值必须清零并运行全量检查。**

规范性要求以 [Coding Agent Collaboration Covenant](../AGENTS.md) 为准；本文解释如何在日常开发中执行。

## 三个级别

| 级别 | 典型改动 | 当次必须完成 | 是否计入累计 |
| --- | --- | --- | --- |
| Level 0 | 纯文档、注释、非运行时治理文本 | `git diff --check`，以及对应文档/governance smoke | 否 |
| Level 1 | 单一纯函数、低耦合 renderer、窄范围回归修复 | 语法检查、直接契约测试、最近邻集成测试；交互变化补一条窄范围浏览器验证 | 是 |
| Level 2 | CLI、进程、平台、安装卸载、端口、Capture、OTel、数据库、导入导出、安全、工作流、包边界，或累计检查点 | Level 1 的聚焦证据，加当前主机完整 `release:check:<platform>` | 完成后清零 |

无法确定级别时向上取一级。测试失败且不能马上证明是测试环境问题时，也向上升级，不能用“改动看起来很小”继续累计。

## 累计规则

- 最近一次在当前分支精确 HEAD 上通过完整平台 profile 后，Level 1 计数从 0 开始。
- 每个包含运行时代码的 Level 1 提交加 1；Level 0 不计数。
- 第 3 个 Level 1 提交可以正常完成聚焦测试和提交，但在开始第 4 个代码提交或推送当前批次前，必须运行 Level 2。
- 高风险改动立即触发 Level 2，不等待计数达到 3。
- 代码推送、跨 Agent 交接、PR、合并和发布候选都属于强制检查点。推送后仍由 GitHub Actions 运行 macOS、Windows、Linux 三平台矩阵。
- 完整 profile 只证明它实际测试的 SHA。通过后又产生运行时代码提交，计数立即重新从 1 开始。

## 推荐工作节奏

1. 修改前标记本次级别和最近的测试边界。
2. 每个小改完成后立即运行聚焦测试，保持提交职责单一。
3. 可以连续完成最多 3 个低风险代码提交，不必在每个提交后重复完整门禁。
4. 到阈值、高风险点或准备共享时，运行当前平台完整 profile。
5. 完整 profile 通过后批次推送，用三平台 CI 验证精确提交 SHA。
6. 真实浏览器或真实 Agent 暴露出的稳定不变量，应提炼成确定性 smoke，减少以后手工重复劳动。

## 示例

### 可以累计

- 提取一个无副作用的 Viewer HTML renderer，并有直接契约测试。
- 把一个事件绑定器拆成 controller，补绑定次数和事件路由 smoke。
- 修复一个局部搜索高亮问题，并在一条真实 Trace 上完成窄范围浏览器验证。

这三项可以各自提交。第三项完成后，在继续下一项或推送前运行完整本机 profile。

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
Next mandatory full checkpoint: before push or the fourth Level 1 code commit
```

完整检查报告必须继续写明精确 SHA、主机环境、命令和退出码。不要使用“最新代码已通过”这种无法复现的表述。
