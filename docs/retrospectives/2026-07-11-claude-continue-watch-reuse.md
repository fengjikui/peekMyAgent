# Claude continue/resume 监听复用修复复盘

日期：2026-07-11

## 问题

用户通过 `pma claude -c` 继续 Claude Code 会话时，peekMyAgent 能提示存在一条历史监听，交互提示也声明“默认 1：继续写入已有监听”，但实际运行后仍可能在左侧出现新的捕获会话。

这破坏了产品约定：Claude Code 的会话已经继续，Trace 也应默认继续写入同一 watch；只有用户明确选择 `--new` 或交互选项 2 时才应拆成新记录。

## 排查证据

1. `askClaudeWatchReuse()` 对空输入的解析本身正确：直接回车返回复用。
2. proxy capture 在进入 Agent 前调用 `resolveClaudeRunWatchChoice()`，已有显式复用 smoke。
3. OTel capture 在 capture mode 分支中提前返回 `runClaudeOtelAgent()`，完全绕过 watch 选择。
4. `runClaudeOtelAgent()` 每次无条件生成新的 `claude-code-otel-*` watch id。
5. 服务端 `/api/watch/start` 在收到失效的 `reuse_watch_id` 后会继续执行通用查找，最终可能静默创建新 watch。
6. OTel ingestor 每个 dump 目录都从 request index 1 开始；即使直接复用 watch id，也会产生重复索引。

## 根因

watch 选择最初只在 proxy wrapper 中实现，OTel fallback 后加入时复用了持久化入口，却没有复用 wrapper 的会话归属策略。两条 capture 路径因此具有不同的生命周期语义。

同时，API 将“尝试复用”和“必须复用这个目标”混在同一容错路径中，导致明确选择无法复用时没有失败信号。

## 修复

- 在判断 proxy/OTel 之后、启动 Agent 之前统一解析 conversation 和 watch 选择。
- OTel wrapper 接受选中的 `watch_id`，并在输出中标记 `(reused)` 或 `(new)`。
- CLI 传递候选对象的真实 `watch_id`，不再优先传 Viewer source id。
- `/api/watch/start` 对失效的显式 `reuse_watch_id` 返回 409，不再静默新建。
- SQLite store 增加 `nextRequestIndex(watchId)`；OTel ingest 仅为新 capture 分配从当前最大值继续的序号。
- proxy 启动输出同样显示 `(reused)` 或 `(new)`，便于用户直接确认行为。

## 回归验证

- `smoke:run-claude`
  - 明确复用不存在的 watch 返回 409。
  - 第一次 fake OTel wrapper 创建 source。
  - 第二次使用同一 session 和 `--watch reuse` 后 source id 不变。
  - 两次请求的 index 为 `[1, 2]`。
- `smoke:otel-ingest`
  - 第二个独立 dump 目录写入同一 watch。
  - source 数量不增加，请求总数累计。
  - request index 保持 `[1, 2, 3]`。
  - response count 与真实配对数量一致。

## 剩余边界

- 非交互环境仍默认新建，避免脚本等待输入；需要复用时必须显式传 `--reuse`。
- `-c` 无法在启动 Claude Code 前直接得到会话 id，因此交互候选依赖同 Agent、mode 和 workspace 下最近的监听；用户仍可选择 2 或 `--new` 拆分。
- OTel request/response 文件仍按时间顺序进行位置配对，该启发式边界与本次 watch 复用修复无关。
