# Agent Composer View 契约

更新时间：2026-07-14

底部 Agent Composer 是一个独立的 Agent 消息发送 feature。它不是当前终端的 PTY：发送会启动一次 detached resume，原终端不显示该消息，也不会把该消息继承进原终端后续上下文。

## 模块边界

- `src/viewer/agent-composer-model.js`：根据 source 能力和发送状态生成 View DTO，统一可用性、目标、警示和结果文案。
- `src/viewer/agent-composer-renderer.js`：只根据 View DTO 生成表单 HTML。
- `src/viewer/agent-composer-controller.js`：长期持有表单事件、每个 source 的草稿/发送状态，以及 `send -> refresh source` 生命周期。

`client.js` 只注入 `ViewerApiClient.sendAgent()`、source 刷新、i18n 和格式化函数。Controller 不读取全局 `state`，不使用全局 DOM 查询，也不直接发送 `fetch`。

## 稳定行为

- 只有可恢复、正在监听且受支持的 Claude Code/OpenClaw source 可以发送。
- Enter 发送；Shift+Enter 换行；IME 组词时 Enter 不发送。
- 同一 source 的局部或整页重绘保留尚未发送的草稿。
- 发送状态按 source 隔离，不得把上一会话的结果展示到另一会话。
- 发送失败恢复原草稿并显示错误；所有草稿、错误和目标文字必须 HTML 转义。
- 消息已发送但 Trace 刷新失败时保留成功结果并提示刷新错误，不恢复草稿，避免用户误重试造成重复发送。
- Server 返回新的 live source id 时，发送状态随逻辑会话迁移，并刷新该 source。

`scripts/agent-composer-view-contract-smoke.mjs` 直接覆盖能力判断、DTO/HTML、草稿保持、成功刷新、source 隔离、失败恢复、转义和事件边界。真实 Agent 命令构造与 detached resume 语义继续由 `scripts/agent-send-smoke.mjs` 覆盖。
