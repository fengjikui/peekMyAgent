# JSON Array File Index 契约

更新时间：2026-07-14

`src/server/json-array-file-index.mjs` 为 file/demo 和 imported Trace 的 `proxy-captures.json`、`debug-api-sources.json` 提供有界页面读取。它是 `SourceCaptureReader` 的文件后端，不解释 Turn、Context Delta、工具交换或子 Agent 语义。

## 目标与边界

- 原始 Trace 始终只读；索引不得写入证据目录或导入目录。
- 首屏、后续页和已定位请求窗口只 hydrate 对应 JSON 对象，不再 `JSON.parse` 整个数组。
- sidecar 只保存对象的 byte start/end，不复制 prompt、response、工具结果、本机路径或其他 Trace 内容。
- 完整导出仍显式读取全部 capture；索引不能改变导出语义。
- 索引持久化失败只是性能降级，不能让一个原本可读的 Trace 消失。

## 私有 Sidecar

Viewer 把 sidecar 写入自身状态目录：

```text
<state>/cache/json-array-indexes/<source-path-hash>-<fingerprint-hash>.json
```

文件名使用真实源路径的 SHA-256 截断值，但 sidecar 内容不保存源路径。目录和文件在支持 POSIX mode 的系统上分别使用 `0700`、`0600`；Windows 或不支持 mode 的文件系统继续依靠用户状态目录权限。

索引文件使用 `peekmyagent.json-array-file-index.v1`，并绑定以下源文件指纹：

- 文件字节数；
- `mtime` 与 `ctime`；
- 头尾各最多 4 KiB 的 SHA-256 样本。

任一字段变化都会使用新 sidecar，并尽力删除同一路径的旧版本。构建前后指纹不一致时会重建一次；读取切片失败时也会强制重建一次，避免把 stale offset 当成事实。

## 解析契约

索引器按固定大小 chunk 扫描 UTF-8 JSON array，并在字符串/转义状态之外维护对象、数组 delimiter stack。顶层元素必须是 JSON object；字符串中的 `{`、`}`、`[`、`]`、逗号和转义引号不构成边界。

索引构建只验证数组和对象边界。某个对象的完整 JSON 语法在该对象真正被 hydrate 时由 `JSON.parse` 验证。这样首次建立 legacy 索引仍需线性扫描文件，但不会同时把整条 Trace 或每个 capture 对象保留在内存。

## Request Window

已读取页面会把 `capture_id` 与 `request_index` 记入进程内 identity map，因此从时间线点击 Raw/detail 可以直接定位目标及前序窗口。服务刚重启后若直接访问一个尚未读取的 request deep link，索引器会按 offset 顺序 hydrate identity，直到找到目标；这是当前的兼容回退，不是普通页面读取路径。

后续若 deep-link 性能成为实际瓶颈，可以在不修改 `SourceCaptureReader` 协议的前提下升级 sidecar identity schema。

## 安全和资源上限

- 持久化 sidecar 最大读取 32 MiB，最多 100,000 个元素；所有 offset 必须单调且位于源文件范围内。
- sidecar 使用同目录临时文件和 rename 发布；并发进程已先写入同一版本时直接复用结果。
- cache 目录不可写、只读挂载或权限模型不支持时，索引保留在当前进程内。
- 原始文件变化、消失或截断不能被缓存错误掩盖。

## 验证

```bash
npm run smoke:json-array-file-index
npm run smoke:source-capture-reader
npm run smoke:timeline-cursor-http
```

测试覆盖 pretty/compact JSON、跨 chunk 字符串和转义、嵌套结构、空数组、畸形/截断输入、指纹失效、跨实例 sidecar 复用、私有权限、不可写 cache 回退、请求窗口定位，以及 Reader 不再调用 capture 文件全量 `readJson`。
