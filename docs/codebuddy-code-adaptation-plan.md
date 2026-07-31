# CodeBuddy Code 适配计划与证据

状态：候选实现（2026-07-31）。当前证据基于 `@tencent-ai/codebuddy-code` 2.130.0、真实 CLI 进程和隔离 loopback 假上游；尚未把其他 CodeBuddy 版本、ACP/IDE 通道或非 OpenAI-compatible provider 宣称为已支持。

## 用户路径

CodeBuddy 使用与当前 OpenCode 相同的 model、provider 和 base URL，但认证边界保持独立。环境变量方式：

```bash
npm install -g @tencent-ai/codebuddy-code
export CODEBUDDY_API_KEY='<同一上游的凭据>'
cd <your-project>
pma codebuddy
```

CodeBuddy 原生 `models.json` 方式同样受支持：

```json
{
  "models": [{
    "id": "mimo-v2.5-pro",
    "apiKey": "<由 CodeBuddy 读取的凭据或 ${PROVIDER_API_KEY} 引用>",
    "url": "https://provider.example/v1/chat/completions"
  }]
}
```

模型可以放在用户级 `~/.codebuddy/models.json` 或项目级 `<workspace>/.codebuddy/models.json`，随后直接运行 `pma codebuddy`。PMA 不要求把文件中的 API Key 再导出为 `CODEBUDDY_API_KEY`。

PMA 只读取 OpenCode effective config 中非敏感的 model/provider/base URL，不读取或复制 OpenCode 的认证文件。主模型、轻量模型、推理模型和子 Agent 模型会在当前子进程内统一映射到选中的 model；CodeBuddy 自己继续拥有 `models.json`、`CODEBUDDY_AUTH_TOKEN`、`apiKeyHelper` 或 `CODEBUDDY_API_KEY` 的认证解析。

继续 PMA 已观察过的会话：

```bash
pma codebuddy --continue
pma --reuse codebuddy --continue
pma codebuddy --resume <session-id>
```

当 `--continue` 选择复用既有 PMA Source 时，wrapper 会把它转换成带有已知原生 session id 的 `--resume`，防止 CodeBuddy 恢复了历史内容而 PMA 却新建会话归属。`--fork-session` 始终新建 Source。

## 已验证协议事实

官方模型配置说明支持 OpenAI Chat Completions 的完整 `/chat/completions` URL，也记录了 `CODEBUDDY_BASE_URL`、`CODEBUDDY_API_KEY` 和模型环境变量。参见[腾讯云 CodeBuddy 模型配置](https://cloud.tencent.com/document/product/1749/116119)。

本仓库的真实安装包探针进一步确认 2.130.0：

- `models.json` 的自定义 provider 向配置的完整路径发起 streaming Chat Completions；
- 自定义 model 的完整 `url` 优先于 `CODEBUDDY_BASE_URL`，单独设置后者不足以保证请求经过 PMA；
- PMA 的子进程 hook 能同时覆盖用户级和项目级 `models.json` 中选中模型的内存 URL，明文或环境变量引用形式的 `apiKey` 仍由 CodeBuddy 原样解析；
- 直接设置 `CODEBUDDY_BASE_URL` 时，CLI 在该 base URL 后追加 `/chat/completions`；
- request body 包含累计 `messages`、`tools`、`model`、`stream`、`max_tokens` 和可选 `reasoning_effort`；
- `x-conversation-id` 提供原生会话归属；`x-codebuddy-request` 与 `x-agent-purpose` 提供 Harness 请求用途证据；
- request id、conversation id、认证 header 在持久化前脱敏，PMA 只保留经过白名单校验的 purpose、intent 和 IDE 版本等低敏语义。

可重复证据：

```bash
npm run experiment:codebuddy-local-mock
npm run smoke:codebuddy-config
npm run smoke:run-codebuddy
```

第一个命令需要本机已安装 CodeBuddy，但不需要真实 API 或 Token；它会验证真实 2.130.0 从 `models.json` 取得假凭据、从内存覆盖取得路由，且源文件逐字节不变。后两个使用确定性假命令和假上游，进入发布门禁。

## 适配边界

- `src/adapters/codebuddy-config.mjs` 负责安装检查、OpenCode 非敏感配置映射、子进程环境和 continue/resume 参数语义；`codebuddy-model-config-hook.cjs` 只在 CodeBuddy 子进程读取精确的用户/项目 `models.json` 路径时，把选中 model 的 `url` 改成 Capture Proxy 完整 Chat endpoint。
- hook 不修改用户文件、不把 `apiKey` 导出到 PMA 父进程或持久化，也不改写模型的其他字段。路由参数在 CodeBuddy 应用代码加载前从环境移除；后代 Node 工具即使继承 `NODE_OPTIONS`，也因没有这些参数而不会继续改写配置。
- Capture 复用共享 OpenAI Chat 协议、response normalizer、Protocol Exchange、Metadata、Raw Inspector、Trace、工具循环和子 Agent 图，不增加 CodeBuddy 专用 Viewer renderer。
- `x-agent-purpose=conversation` 保持正常主请求；已验证的 subagent、标题、建议、压缩和后台 purpose 进入 Harness 分类。未知 purpose 保持 CodeBuddy Harness request，不猜测产品语义。
- 精确捕获只覆盖当前 wrapper 子进程，退出即撤销环境覆盖；用户配置文件不修改，其他 CodeBuddy/OpenCode 进程不受影响。

## 未关闭风险

- 发布前必须完成 macOS Level 2、hosted macOS/Windows/Linux CI，并在 Windows/Linux 实机验证全局安装、进程环境、signal 和路径。
- 内存 URL hook 已在 CodeBuddy 2.130.0 的同步配置读取路径验证；升级 CodeBuddy 时必须重新运行真实假上游探针，不能把未来实现变化静默宣称为已支持。
- 当前只对 OpenAI/openai-compatible OpenCode driver 自动映射。其他 driver 必须显式提供已验证的 `--target-base-url` 与 `--model`。
- CodeBuddy 自带 OTel、IDE/ACP、远程控制和更复杂后台任务尚未形成协议证据，不能从 CLI Chat 路径外推。
- 用户必须自行提供 CodeBuddy 可识别的上游凭据；PMA 不跨 Harness 搬运密钥，也不会从 OpenCode `auth.json` 推导 CodeBuddy 凭据。
