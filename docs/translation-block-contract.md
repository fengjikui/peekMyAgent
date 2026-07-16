# peekMyAgent 翻译块协议

更新时间：2026-07-12

## 为什么需要共享契约

翻译缓存是否命中，取决于“同一段材料”在所有入口都得到完全相同的 identity。过去 Server、浏览器 Client、离线提取脚本和 smoke 各自复制规范化与 hash 逻辑，任何一处少处理一个换行、模型名或工作目录，都会出现缓存已存在但界面无法命中的问题。

当前唯一契约位于：

- `src/translation/blocks.mjs`：浏览器和 Node 都可执行的纯函数；
- `src/translation/hash.mjs`：Node SHA-256 封装；
- 浏览器 Client：对同一 lookup key 使用 Web Crypto SHA-256。

## Block identity

规范化步骤按固定顺序执行：

1. `CRLF` 转为 `LF`，并清理首尾空白。
2. 去除 Claude Code 日期变更 preamble。
3. 将模型名替换为 `<model>`。
4. 将主工作目录替换为 `<workspace>`。
5. 将项目 memory 路径替换为 `<project-memory>`。

lookup key 为：

```text
<kind>\0<normalized source_text>
```

缓存 hash 是该 UTF-8 字节序列的 SHA-256。目标语言不进入材料 hash，而是由 cache 文件/namespace 隔离；这允许同一原文块在不同目标语言下复用稳定身份。

这次重构没有改变 key 字节，因此已有翻译缓存保持可用，不需要迁移或重译。

## Marker 对齐

批量请求中的每个 source 以 hash 标识。模型必须返回：

```text
@@PEEK_TRANSLATION <hash>
<translated text>
@@PEEK_END_TRANSLATION
```

worker 使用共享 parser 按 hash 对齐，不依赖模型返回顺序。parser 同时接受 LF 和 CRLF；严格模式下，一个合法 marker 都没有会触发重试。部分 block 缺失或为空时，只丢弃对应 block，其余成功翻译仍写入缓存。

## 工具 schema

工具名、工具说明和参数 description 的提取规则同样位于共享模块。schema walker 会递归处理：

- `properties`；
- 数组 `items`；
- `oneOf`、`anyOf`、`allOf`。

上层仍负责赋予工具索引、路径、occurrence 和 source/session 元数据；共享模块只拥有稳定、无副作用的 block identity 与 schema text 规则。

## 修改规则

修改规范化、key 或 marker 时必须：

1. 先判断是否会使旧缓存失效。
2. 若 key 字节变化，引入显式 contract version 和缓存迁移，不能静默换 hash。
3. 同步 Server、Client、worker 和离线脚本，不得再增加本地 mirror 函数。
4. 更新 `smoke:translation-contract` fixture。
5. 运行 harness、容错、本机 Claude CLI 和 dashboard 静态模块 smoke。

验证命令：

```bash
npm run smoke:translation-contract
npm run smoke:harness-translation
npm run smoke:translation-tolerance
npm run smoke:translation-claude-cli
npm run smoke:dashboard-open
```
