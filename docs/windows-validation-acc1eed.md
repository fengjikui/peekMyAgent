# Windows 重构验证报告（acc1eed）

验证日期：2026-07-10

## 验证基线

- 目标提交：`acc1eed1cf6551ab7cfc1c6abf19c52faf30b175`
- 验证分支：`codex/windows-refactor-audit`
- 系统：Windows 11 家庭版中文版，10.0.26200，x64
- Shell：Windows PowerShell 5.1.26100.8655
- Node.js：v24.14.0
- npm：11.9.0
- Claude Code：2.1.199

本轮重点验证重构后的 CLI/daemon 生命周期、Windows 命令 shim、Claude Code 捕获、SQLite 持久化、Viewer 渐进加载、安全边界和维护命令。

## 自动化结果

- `npm install`：通过。
- `npm run release:check:windows`：最终通过，52 项命令全部退出 0，耗时 263.5 秒。
- `npm run smoke:release-check`：通过。
- `npm run smoke:source-install`：通过。
- `npm run smoke:dashboard-open`：通过。
- `npm run smoke:claude-otel`：真实 Claude Code 通过，捕获到 2 个 request body 和 1 个 response body。

## 真实链路结果

在临时工作区、临时状态目录和随机 loopback 端口执行源码 CLI 的单轮 Claude Code 调用：

- Claude Code 退出码：0。
- 自动选择 capture proxy。
- Viewer API 出现 1 个 Claude Code source。
- 捕获 3 个请求、2 个响应。
- 测试 daemon、数据库、raw body 和临时目录均已清理。

浏览器使用合成 OTel capture 验证：

- 页面非空，三栏布局、会话列表和时间线可见。
- `C:\temp\中文目录\pma-test` 能正确显示，没有路径乱码。
- Tool use、Tool result 和 Raw reconstructed 明细可打开。
- 页面交互未出现阻断错误。

## 已修复问题

### P2：source-install 后 release gate 误报工作树被修改

- 复现：`npm run release:check:windows`
- 现象：`smoke:source-install` 自身通过，但 gate 报 `Command changed tracked files`，`bin/peekmyagent.mjs` 状态为 `M`，两个 Git diff hash 均为空。
- 原因：Windows npm 会把可执行脚本首行的 CRLF shebang 规范化为 LF；Git clean filter 后 blob 未变化，但索引 stat 状态发生变化。
- 修复：release gate 以 worktree/index 的实际 diff hash 判断污染，status 仅保留为诊断信息。
- 回归：增加“同 status 的真实 diff 必须失败”和“仅 status 变化且 diff 相同必须通过”的断言。

### P2：dashboard 参数错误触发 Windows 异常退出码

- 复现：在 daemon 已启动时执行 `node bin/peekmyagent.mjs open --source --print --no-open`。
- 现象：预期退出码 1，实际退出码 `3221226505 (0xC0000409)`。
- 原因：参数错误发生前已有网络句柄；顶层 catch 立即调用 `process.exit(1)`，Node.js 24 在 Windows 上异常终止。
- 修复：改为设置 `process.exitCode = 1`，让事件循环和网络句柄自然关闭。
- 回归：`npm run smoke:dashboard-open`。

### P3：真实 Claude OTel smoke 无法启动 Windows npm shim

- 复现：`npm run smoke:claude-otel`
- 错误：`Error: spawn claude ENOENT`
- 原因：三个真实 OTel 脚本直接 `spawn("claude")`，没有经过项目已有的 Windows `.cmd`/npm shim 解析层。
- 修复：三个脚本统一使用 `childProcessSpawnConfig`，并将 spawn error 转为普通测试失败。
- 回归：在当前 PowerShell PATH 不含 npm global bin 的情况下，`npm run smoke:claude-otel` 真实通过。

## 未修复观察项

### P3：1280×720 下 Viewer 顶部眉题被挤成竖排

在三栏均展开、Raw 面板打开的 1280×720 视口中，`Local dashboard · 请求时间线` 的中文部分接近逐字换行。时间线、Raw 和操作仍可用，因此本轮不修改 UI；该问题不是 Windows 路径或进程兼容问题，建议由 Viewer 重构负责人单独评估响应式约束。

### 环境：当前 Codex PowerShell 未继承 npm global bin

当前自动化 shell 中直接执行 `claude --version` 会报 command not found，但 `%APPDATA%\npm\claude.cmd` 存在且可运行。这是启动进程的 PATH 继承差异。产品 CLI 和本轮修复后的真实 smoke 会通过统一平台层发现 npm shim，不要求用户删除已有 PATH 配置，也不会影响已正确配置 PATH 的机器。

## 修改范围

- `bin/peekmyagent.mjs`
- `scripts/lib/tracked-snapshot.mjs`
- `scripts/release-check-smoke.mjs`
- `scripts/claude-otel-smoke.mjs`
- `scripts/claude-otel-multiturn-smoke.mjs`
- `scripts/claude-otel-vs-proxy-smoke.mjs`

## 剩余风险

- macOS/Linux profile 仍需各自平台在本分支提交上运行。
- 本轮没有运行真实 OpenClaw。
- 本轮真实 Claude Code 验证覆盖单轮 proxy 和单轮 OTel；交互式 `/context`、`/compact`、多子 Agent 仍依赖之前的真实验证与当前 deterministic smoke。
- 1280×720 的 Viewer 顶部布局问题需要单独 UI 修复和浏览器回归。
