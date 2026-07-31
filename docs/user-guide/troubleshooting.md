# 常见问题和故障排查

排障时先运行：

```bash
pma doctor
pma doctor --json
pma --help
```

`doctor` 用于检查安装、状态目录、daemon/端口和已安装集成。不要在公开 issue 中直接粘贴未经审查的完整环境或 Capture。

## 找不到 `pma` 或 `peekmyagent`

重新安装公开 Alpha：

```bash
npm install --global peekmyagent@next
```

源码仓库中可以执行：

```bash
node scripts/install.mjs
```

或暂时绕过全局命令：

```bash
node bin/peekmyagent.mjs open
```

## `no running dashboard found`

先启动 Dashboard：

```bash
pma open
```

Dashboard 会在 PMA 状态目录中保存本地 registry，`watch-current` 通过它找到当前 Viewer。不要手工共享或修改 registry 来指向非 loopback 地址。

## Viewer 左栏没有出现 Source

检查：

1. Dashboard/daemon 是否还在运行；
2. 是否通过 `pma <harness>` 启动了当前 Agent；
3. Harness 是否真正发出了新的模型请求；
4. wrapper 输出的 Dashboard URL 与当前页面是否相同；
5. Source 筛选器是否切到了另一个 Agent。

需要指定 Viewer 时：

```bash
pma watch-current --viewer-url http://127.0.0.1:<port>
```

## 能注册 Claude Code session，但捕获不到请求

`watch-current` 可以识别并关联当前 session，但不能反向修改已经运行的 Claude Code 父进程环境。更可靠的方式是退出后通过 wrapper 恢复：

```bash
pma claude -r '<session-id>'
```

如果必须手工使用代理，macOS/Linux：

```bash
ANTHROPIC_BASE_URL='<proxy-base-url>' claude --resume '<session-id>'
```

Windows PowerShell：

```powershell
$env:ANTHROPIC_BASE_URL = '<proxy-base-url>'
claude --resume '<session-id>'
```

只有恢复后产生的新请求会经过代理。

## 左栏出现重复 watch

恢复会话时应明确选择复用或新建。交互终端可以使用 `--reuse` / `--ask` 控制；不需要的 Source 通过会话菜单停止或清空。不要直接删除 SQLite 文件来“整理列表”。

## 请求存在，但没有 response

先区分：

- 上游仍在流式输出；
- Harness 或用户中途取消；
- daemon 重启打断正在进行的流；
- Capture transport 只拿到请求，没有完整响应；
- response 过大、按需加载或发生解码错误。

查看 Request 的 provenance、response status、终态事件和 Raw。不要用后续 Assistant 自然语言补写一份不存在的原始 response。

## 工具结果没有关联来源

在 Raw 中搜索 call id / tool use id，确认：

1. 产生调用的请求已被捕获；
2. 结果携带相同 id；
3. adapter 没有把 id 截断或脱敏；
4. 结果确实是协议 tool result，不是日志摘要。

缺少稳定 id 时应报告为未知关联。

## 没有看到子 Agent 看板

确认 Trace 中同时存在：

- 父级 spawn / Agent 工具调用；
- 子请求的实例 id、子线程 id或可验证 prompt 对应；
- 结果回流或终态证据。

通用协议桥不会自动理解私有多 Agent 语义。只有自然语言出现“子 Agent”也不会建立分支。

## System diff 显示一致或摘要

- “一致”表示抽取出的 System 文本一致，不代表整个请求完全一致；
- 超大 System 会使用有界块摘要，块增删数不是精确行数；
- 原始对象结构与非文本字段继续在 `System` 原文和 Raw 检查。

## 担心 token 或密钥泄露

PMA 默认在本机运行并脱敏常见敏感 header，但正文仍可能包含凭据或隐私。不要公开完整 `env`、Raw JSON、真实截图或 Trace 包。需要共享问题时，优先使用确定性假上游和虚构 `/demo/...` 路径复现。

## 导入的 Trace 为什么不能继续监听

导入 Source 是只读证据包：可以查看时间线、System、Tools、Response、Raw 和多 Agent 结构，但不会获得原机器上的进程、凭据或 watch 能力。这是预期的安全边界。

## 仍然无法定位

记录以下最小信息，再提交产品反馈：

```text
PMA 精确版本与 commit：
操作系统和架构：
Node/npm 版本：
Harness 与版本：
启动命令（移除 key 和隐私参数）：
Capture transport：
预期看到什么：
实际看到什么：
是否可用确定性假上游复现：
```

不要上传未经脱敏的 Capture；先描述证据缺口，再协调安全的复现方式。
