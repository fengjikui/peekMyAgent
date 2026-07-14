# Viewer 翻译动作控制器契约

更新时间：2026-07-14

本文描述 Viewer 中“用户触发一次翻译动作”所经过的边界。翻译缓存 identity 与 lookup 见[翻译缓存上下文契约](translation-cache-controller-contract.md)，材料 hash 与 marker 见[翻译块协议](translation-block-contract.md)，结构化展示见[翻译视图契约](translation-view-renderer-contract.md)。

## 为什么存在这个模块

刷新当前区块、自动补齐、重译一个块、整组重译工具参数和复制译文都不是纯展示动作。它们同时依赖当前 Source、目标语言、request、缓存 operation token、provider 请求、剪贴板和局部重绘。过去这些步骤分散在 `client.js` 中，容易出现三类问题：

- 切换 Source 或语言后，旧 provider 结果仍覆盖当前页面；
- Raw 与 Timeline 各自维护 action id、复制格式或重译分支；
- 工具整段复制遗漏工具名，或参数组被拆成多次 provider 请求。

`src/viewer/translation-action-controller.js` 现在拥有有副作用的动作生命周期；`translation-action-model.js` 只拥有可直接测试的文本结构。

## Action Controller 拥有的责任

- 注册和清理 Raw/Timeline render-local action id。
- 执行单块复制和当前 section 整段复制。
- 执行显式刷新、自动刷新和单块/整组材料重译。
- 在 provider 调用前按需补载 request detail。
- 通过 `translation-generation-operation.js` 串联 prepare、generate、cache reload 和 commit。
- 同时校验自身 sequence 与 Cache Controller operation token，拒绝旧 Source/语言结果。
- 管理 generation loading、error、完成文案和当前翻译模式切换。
- 只请求受影响的 Raw section 或 Timeline 局部重绘。

## Action Controller 不拥有的责任

- 不访问 DOM、`window`、`localStorage`、全局 `state` 或 `fetch`。
- 不生成 HTML，不实现 Raw/Timeline/翻译搜索。
- 不决定翻译块 hash、缓存路径、provider 选择或服务端材料上限。
- 不拥有缓存 lookup、自动刷新 timer 或 request detail cache。
- 不从请求协议中重新提取 System、Tools 或 Harness 语义。
- 不直接实现浏览器剪贴板；应用层通过 `copyText` 端口适配。

## Action Model 拥有的责任

`translation-action-model.js` 是无副作用纯模型，负责：

- 把单 action 规范化为 provider `materials`；
- 生成单块复制文本；
- 生成 System/Harness/Tools 整段复制文本；
- Tools 输出先写工具名，再写工具说明与参数名，避免失去 schema 归属；
- 根据缓存命中、translated、remaining 和 section stats 生成稳定完成文案。

模型不读取缓存、不注册 action、不操作剪贴板，也不访问 DOM。

## 端口

| 端口 | 作用 |
| --- | --- |
| `getContext()` | 读取当前 Source、目标语言、Agent、request、section、Raw mode |
| `getGenerationState()` / `setGenerationState()` | 读写唯一 generation 状态 |
| `cache.captureOperation()` / `isOperationCurrent()` | 签发并复核缓存上下文 token |
| `cache.reload()` / `isAvailable()` | provider 成功后刷新公开缓存并读取可用性 |
| `data.ensureRequestDetail()` | 生成前补载 compact request 的完整材料 |
| `data.requestFor()` / `sectionMaterials()` / `sectionStats()` | 提供当前 request、复制材料与命中统计 |
| `api.generateTranslations()` | 调用受 Viewer API contract 保护的 provider 入口 |
| `ui.copyText()` | 浏览器剪贴板与按钮反馈适配 |
| `ui.renderRaw()` / `renderTimeline()` | 局部重绘，不触发整页 `renderAll()` |
| `ui.setTranslationMode()` | 当前操作成功且缓存命中后切换译文模式 |

## 竞态与行为不变量

1. Source 或目标语言改变时，`invalidate()` 必须递增 action sequence 并清空 generation 状态。
2. prepare、provider、cache reload 任一阶段后发现 token 失效，后续副作用必须停止。
3. 自动刷新携带预期 Source/语言；timer 到期前已经切换上下文时返回 `stale`，不能调用 provider。
4. 同一时刻只允许一个 generation；重复点击返回 `busy`。
5. Raw action 只重绘原 request/section；Timeline Thinking action 只重绘 Timeline。
6. 工具参数组作为一次 `materials` 请求重译，不逐参数制造 provider 风暴。
7. `clearActions("raw")` 只移除 Raw action；全清理会重置 render-local id。
8. Tools 的“复制全部”必须包含工具名、工具说明、参数名、原文和已有译文。
9. Action Controller 不得把 provider 成功等同于当前页面可提交；必须同时通过自身 sequence 与缓存 token。

## 应用装配规则

`client.js` 只负责把 Store、RequestDetailCache、ViewerApiClient、TranslationCacheController、浏览器剪贴板和局部 renderer 组装成端口。事件委派读取 `data-translation-*` 属性后调用 Controller，不再自行解释 action payload。

新增翻译动作时先判断其生命周期属于 Cache、Action、Search 还是 Renderer。不要在 `client.js` 新增第二份 generation sequence、action Map、Tools clipboard formatter 或 provider/cache 编排。

## 验证

直接契约：

```bash
npm run smoke:translation-action-controller-contract
npm run smoke:translation-generation-operation-contract
npm run smoke:translation-cache-controller-contract
npm run smoke:translation-view-renderer-contract
npm run smoke:viewer-timeline-surface-contract
```

`smoke:translation-action-controller-contract` 覆盖单块/Tools 整段复制、完整工具名、显式生成、详情补载、provider payload、cache reload、模式切换、旧 Source 结果拒绝、整组参数重译、surface action 清理和 action id 重置。浏览器回归还需验证 Raw 翻译工具栏、复制、重译、Source/语言切换与控制台无错误。
