# Viewer 翻译缓存上下文契约

更新时间：2026-07-14

本文面向继续维护 Viewer 的 Coding Agent，描述浏览器中翻译缓存、译文 lookup 与自动刷新去重的当前边界。翻译块 identity 仍以[翻译块协议](translation-block-contract.md)为准，结构化展示仍以[Viewer 翻译视图契约](translation-view-renderer-contract.md)为准。

## 为什么存在这个模块

一个 Source 的翻译视图同时依赖 Source identity、目标语言、可用于查找缓存的 Agent 名称、当前已经水合的 request，以及异步缓存请求。用户快速切换 Source 或语言时，旧请求可能更晚返回；compact request 的详情也可能在缓存读取期间补载。如果这些状态继续分别保存在 `client.js`，页面很容易把旧语言、旧 Source 或缺少详情的 lookup 提交到当前视图。

`src/viewer/translation-cache-controller.js` 把这组状态收敛为一个显式上下文：

```text
Source 或目标语言变化
  -> 激活 context(sourceId, targetLanguage)
  -> 使旧 load / lookup / timer 失效
  -> 按候选 Agent 顺序读取缓存
  -> 使用此刻最新的 request 集合构建 lookup
  -> 只有当前 operation 可以提交

缓存未命中
  -> 按 source + agent + language 去重
  -> generation 未忙时调度一次自动刷新动作
  -> callback 执行前再次确认 context 仍然有效

request detail 补载
  -> cache load / lookup build 期间标记当前 request 集合为 dirty
  -> 提交前使用最新 request 自动重建 lookup
  -> 缓存已提交时直接重建 lookup
  -> 旧 lookup 结果不能覆盖后续 Source/语言或更新的 lookup
```

## 控制器拥有的责任

- 当前翻译上下文的 Source identity 与目标语言。
- 候选 Agent 的有序缓存探测和首个可用缓存选择。
- 当前缓存响应与 `kind + source_text` 译文 lookup。
- cache load、lookup rebuild 和上下文切换的 operation 顺序。
- 使用 context epoch 与 operation sequence 拒绝迟到结果。
- 为应用层签发可复核的 Source/语言/Agent operation token，使生成流程能在每次异步等待后拒绝旧上下文副作用。
- 自动刷新尝试的 `source + agent + language` 去重。
- 缓存不可用和缓存请求失败的稳定公开状态。

## 控制器不拥有的责任

- 不访问 DOM、`window`、`localStorage`、全局 Viewer state 或 HTTP URL。
- 不决定当前 Raw section、request、翻译模式或搜索查询。
- 不发送翻译生成请求，不管理 generation 文案、loading 或 error UI。
- 不注册复制/重译 action id，也不操作剪贴板。
- 不收集 System、Tools、Harness 的领域材料；材料收集函数通过 lookup builder 端口注入。
- 不渲染翻译卡片、工具参数、Markdown 或缓存状态 HTML。
- 不重新定义翻译块规范化、lookup key 或 SHA-256 算法。

主动刷新和块级重译仍由应用装配层执行；它们通过纯 `translation-generation-operation.js` 统一详情准备、provider、cache reload 三个异步阶段的失效检查。`translation-view-model.js` 与 `translation-renderer.js` 仍只负责结构化展示。不要为了得到一个“统一翻译控制器”而把这些不同生命周期重新聚合。

## 依赖端口

| 端口 | 作用 |
| --- | --- |
| `loadCache(agent, targetLanguage)` | 读取某个 Agent/语言的缓存；浏览器装配到 `ViewerApiClient.translations` |
| `buildLookup(requests, cache)` | 使用共享块 key 和当前 request 集合构建译文 Map |
| `schedule(callback)` | 把自动刷新动作放到当前事件之后；浏览器使用零延迟 timer |
| `onAutoRefresh(context)` | 通知应用层执行一次自动翻译刷新，不由控制器发送请求 |
| `isGenerationBusy()` | 防止已有翻译生成任务工作时重复触发自动刷新 |
| `onWarning(message, error)` | 报告缓存读取失败，不把日志策略写入控制器 |

`loadContext()` 的 `getRequests` 是刻意设计的读取端口：缓存网络请求返回后再读取已经补载的最新 request，而不是固化调用开始时的 compact 数组。若详情恰好在 lookup hash 计算期间到达，`refreshLookup()` 会递增 request revision；控制器在提交前发现 dirty revision 后重新读取并构建，详情通知不会丢失。

## 竞态保证

控制器维护三个相互配合但职责不同的序号：

- `contextEpoch`：Source 或目标语言变化时递增，使旧上下文全部失效。
- `loadSequence`：同一上下文多次加载时递增，只有最后一次缓存加载可以提交。
- `lookupSequence`：详情补载触发多次 lookup 重建时递增，只有最后一次计算可以提交。

因此应保持以下不变量：

1. 先选择 Source A、再选择 B，A 的慢缓存不能覆盖 B。
2. 同一 Source 连续刷新两次，较早请求即使最后返回也不能覆盖较新缓存。
3. 目标语言从中文切到日文后，中文缓存和中文自动刷新 timer 都不能提交。
4. 缓存读取期间补载 request detail，最终 lookup 使用补载后的 request 集合。
5. 详情触发的 lookup 正在计算时切换 Source，旧 lookup 返回 `null` 且不修改当前 Map。
6. 同一 `source + agent + language` 缓存缺失只自动刷新一次；显式清理尝试后才允许重试。
7. timer 执行前必须重新确认当前首选 Agent、缓存可用性、缓存加载和 generation 状态；同一上下文后续已经命中缓存时，旧 timer 不得再发起生成。
8. `invalidate()` 必须同时撤销 timer token 与自动刷新 attempt；返回曾访问的 Source 时允许重新尝试。
9. 应用层的生成和块级重译必须携带 `captureOperation()` 返回的 token，并在详情补载、provider 请求和缓存重载后的每个 `await` 后调用 `isOperationCurrent()`；旧 Source/语言不得更新 loading、提示文案或翻译模式。

网络取消以后可以作为优化加入，但不能替代这些提交前校验。

## 应用层装配

`client.js` 当前只负责：

- 从 `state.data` 提供 Source、request 与目标语言。
- 把缓存 API、共享材料收集/hash/key 函数注入控制器。
- 在 Source 切换时立即 `invalidate()`，避免新 Source 加载期间继续显示旧译文。
- 在 `RequestDetailCache` 补载完成后调用 `refreshLookup()`。
- 用控制器公开的 cache/lookup 驱动 Translation View Model 和 Renderer。
- 收到 `onAutoRefresh` 后执行既有生成流程并局部刷新可见界面。
- 将回调给出的 Source、目标语言和 Agent 原样带入生成操作；生成流程开始即进入 busy 状态，并在每个异步边界后复核控制器 token。
- 通过 `runTranslationGenerationOperation()` 编排详情准备、provider 请求和 cache reload；任一阶段后 token 失效时跳过后续副作用并清理仍归该 operation 所有的 loading。

不要在 `client.js` 恢复 `state.translations`、`state.translationLookup` 或 `state.translationAutoRefresh`。也不要让 Controller 反向调用 Raw Inspector 或 Renderer。

## 修改规则

- Source identity 或目标语言定义变化时，先明确是否应改变 context key，并补竞态测试。
- 新增 Agent alias 时只扩展纯候选函数，保持稳定顺序与去重。
- cache API 增加 AbortSignal 时仍需保留 epoch/sequence 校验。
- 翻译材料 identity 变化必须先更新共享 translation block contract，不能只改浏览器 lookup。
- 生成、复制、重译或 Renderer 行为变化不应进入本控制器，除非其生命周期所有权真的发生改变。
- 当前行为变化必须同步本文、`architecture.md`、`codebase-map.md`、路线图状态和直接 smoke。

## 验证

直接契约：

```bash
npm run smoke:translation-cache-controller-contract
npm run smoke:translation-generation-operation-contract
```

该 smoke 覆盖 Agent 候选顺序、共享 lookup 去重、候选缓存回退、缓存 I/O 和 lookup build 两个阶段的详情补载、无 Agent 状态、缓存 miss、自动刷新去重、generation busy、旧 Source/语言、同上下文并发加载、缓存后来可用时的 timer 取消、lookup 重建、timer/attempt 失效、operation token、错误状态和显式 invalidate。集成修改还应运行 Translation View、Viewer Timeline Surface、Static Assets、Package smoke，并用真实浏览器验证 Source/目标语言快速切换。
