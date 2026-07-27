# Viewer 字段级懒加载契约

更新时间：2026-07-27

Viewer 的 compact Timeline 已经按 request 懒加载完整详情。本契约继续把单条详情中的图片载荷和大型工具结果拆成第二级按需读取，避免未查看内容进入浏览器网络响应和 DOM。

## 当前范围

- `data:image/<safe-raster>;base64,...` 和带明确图片 MIME 的原始 base64 字段会替换为图片占位。
- 工具结果上下文中的 UTF-8 字符串达到 4096 字符时会替换为文本或 JSON 占位。
- 普通用户文本、System、Tools schema 和 Harness/翻译材料不因长度自动替换，避免改变既有语义与翻译契约。
- 安全图片 MIME 当前只接受 PNG、JPEG、GIF、WebP 和 AVIF；SVG 不生成可渲染图片引用。

占位 DTO 使用 `peekmyagent.lazy_payload.v1` 标记，并保留本地引用、kind、encoding、MIME、字节数、SHA-256、文本字符/token 近似，以及可解析时的图片宽高。占位不包含原字段内容或内容预览。

## 读取链路

1. `/api/request` 仍构造完整的单请求语义投影，但在 HTTP 序列化前由 `lazy-payload-service.mjs` 替换符合范围的字段。
2. Renderer 只创建一行占位和显式的“加载内容”或“查看图片”动作。
3. 用户点击后，`GET /api/request/payload?source=...&request=...&ref=...` 在同一 loopback 安全边界重新定位该请求和字段。
4. Service 解码并验证服务端生成的结构路径，重新执行懒加载资格判断；任意未达门限或被篡改的路径不得作为通用字段读取器。
5. Client 将结果写回 `RequestDetailCache` 中的对应 marker，并只刷新当前 Raw Inspector。工具结果显示为有上限滚动区；图片在本地构造受限的 `data:` URL 后显示。

字段内容不会上传到外部服务。打开占位本身不触发翻译；只有原有显式翻译动作继续进入既有 provider 边界。Raw 搜索在字段未加载时只看到占位元数据，显式加载后才可搜索该字段内容。

## 当前性能边界

当前实现消除了重字段的详情响应传输、JSON 解析和初始 DOM 成本，但为了复用现有 `ViewerTraceProjector` 语义，Server 在生成 `/api/request` 时仍会短暂重建完整 request window。SQLite request-tree 的 blob metadata/skeleton 直读和 file/import 的字段级 byte-range 读取属于后续存储优化，不能把当前实现描述为零服务端水合。

## 验证

```bash
npm run smoke:lazy-payload-contract
npm run smoke:view-compact-detail
npm run smoke:viewer-router-contract
npm run smoke:viewer-api-client-contract
npm run smoke:request-detail-cache-contract
npm run smoke:message-view-renderer-contract
npm run smoke:viewer-static-assets-contract
```

端到端 smoke 必须证明 `/api/request` 不包含大型工具结果尾部和图片 base64，而每个显式 payload ref 能逐字取回原值。真实浏览器场景还需验证单行占位、加载/重试状态、文本滚动区、图片尺寸与控制台错误。
