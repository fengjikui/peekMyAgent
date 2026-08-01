# 通过通用协议桥接入自研 Harness

如果自研 Harness 已经从环境变量读取 OpenAI-compatible 或 Anthropic-compatible base URL，通常不需要先给 PMA 开发专用 Agent adapter。`pma observe` 可以只对被包装的子进程临时替换这个变量。

## OpenAI-compatible

假设真实上游保存在 `OPENAI_BASE_URL`：

```bash
export OPENAI_BASE_URL='https://example.invalid/v1'

pma observe \
  --name my-agent \
  --base-url-env OPENAI_BASE_URL \
  --conversation-id my-agent-debug-1 \
  -- my-agent run
```

`--` 是强制边界：前面是 PMA observe 选项，后面是完整且原样传给子进程的命令。

## Anthropic-compatible

```bash
export ANTHROPIC_BASE_URL='https://example.invalid'

pma observe \
  --name my-anthropic-agent \
  --base-url-env ANTHROPIC_BASE_URL \
  -- python agent.py
```

## 运行契约

- `--name` 只是 Source 展示名，不决定协议；
- PMA 启动前读取指定变量作为真实上游；
- 只有 child env 中的该变量被替换为 watch proxy URL；
- 父 shell、用户配置和其他进程不变；
- 原上游 path prefix 会保留，常见 `/v1` 不会丢失；
- API key、其他环境变量、stdin/stdout、信号和退出码继续透传；
- 子进程退出后 watch 停止，Trace 保留；
- PMA 的启动信息不打印完整 child argv。

也可以显式提供上游：

```bash
pma observe \
  --name my-agent \
  --base-url-env OPENAI_BASE_URL \
  --target-base-url https://example.invalid/v1 \
  -- my-agent run
```

即使使用 `--target-base-url`，仍要用 `--base-url-env` 指明给子进程覆写哪个变量。

## 安全边界

上游必须是 `http` 或 `https`，URL 中不能嵌入用户名、密码、query 或 fragment。不要把 API key 放进子进程参数；即使 PMA 不打印 argv，系统上的其他进程工具仍可能观察命令行。

Capture Proxy 应只绑定 loopback。认证 header 在持久化前按现有规则脱敏，但请求正文仍可能包含敏感上下文。

## 通用桥能证明什么

通用桥可以证明：

- 这个子进程的 OpenAI Responses / Chat 或 Anthropic Messages HTTP 交换经过 PMA；
- Viewer 可以检查上行、下行、工具交换和 Raw；
- child-only 环境变量覆盖在进程退出后消失。

它**不能仅凭协议**证明：

- Harness 的权限与审批语义；
- Skill/command 加载机制；
- 上下文压缩或会话恢复行为；
- 子 Agent 父子关系；
- 私有 header、metadata 或工具的准确含义。

这些信息在没有证据时应保持 unknown。

## 真实例子：两次 Request 的目录工具闭环

仓库内置了一条不需要业务背景的公开教学场景：用户只要求“列出当前演示目录第一层的内容，并说明新用户应该先看哪个文件”。同一任务分别通过 OpenAI Responses 和 Anthropic Messages 发送，两个 Source 都由真实 `pma observe` 包装，远端回复则由确定性 loopback 假上游生成。

| 阶段 | Harness 与模型之间的交换 | 在 Viewer 中看什么 |
| --- | --- | --- |
| Request 1 | System、用户消息、模型参数和 `list_directory` 工具定义上行；模型返回工具调用 | 时间线先定位 `工具调用`，右栏再核对 Metadata、Tools 与调用参数 |
| Harness 本地动作 | Harness 执行虚构目录的只读枚举，得到 `README.md` 和 `docs/` | 点 `工具结果`，再用 `来源 #1` 回到对应调用 |
| Request 2 | Harness 把工具结果送回模型；模型返回“新用户先读 README.md” | 协议视图核对角色、顺序和 call id，Raw 核对原始 body 与 header 脱敏 |

![OpenAI Responses 中工具调用与结果回传的协议证据](../../assets/demo/source/custom-harness/recording/review-1920/07c-openai-output.png)

OpenAI Responses 中，工具调用和结果分别表现为 `function_call` 与 `function_call_output`；Anthropic Messages 中，对应角色是 assistant 的 `tool_use` 与后续 user message 中的 `tool_result`。PMA 用捕获到的 wire path 和 body 识别协议，不靠 Source 名称猜测。

可重复素材保存在 `assets/demo/source/custom-harness/`：`manifest.json` 记录 Source、产品 SHA、脱敏边界与原图校验值；`narration.zh-CN.md` 是完整镜头脚本；两档 `review-*` 目录用于检查 1920×1080 和 1024×576 下逐步出现的标注。重新生成 Source 时运行：

```bash
node scripts/custom-harness-protocol-demo.mjs
```

脚本只访问 loopback，使用固定的 `/tmp/pma-custom-harness-demo/public-project` 虚构目录和占位认证值。不要把它改成读取真实项目或真实凭据后再提交公开素材。

## 什么时候需要专用 adapter

满足任一条件时，继续使用[新 Harness 适配工作手册](../new-harness-adaptation-playbook.md)：

- Harness 不支持进程级 base URL 覆写；
- provider URL 由私有配置文件或运行时 SDK 强制决定；
- 需要恢复会话 identity、子 Agent 或 Harness 内部请求；
- 需要可逆 patch 配置；
- 通用协议不能解释真实请求形状。

专用 adapter 必须从真实、非敏感证据包出发，不应从品牌名或单一请求猜测机制。
