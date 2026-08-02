# 协议视图与 Raw：定位一次 call id 异常

> 状态：中文故事 v0.1；真实 Capture Proxy Source、1920×1080 Viewer 原始帧、20 个渐进状态与双尺寸视觉复核完成，等待所有者内容审阅。

## 演示合同

- 目标用户：需要排查模型请求、兼容层或自研 Harness 异常的开发者；
- 核心问题：普通摘要只能看到“失败”时，怎样找到出错的原始字段并验证修正；
- 场景：一个只读目录工具的 `function_call_output.call_id` 把字母 `o` 写成数字 `0`；
- 证据：真实 PMA Capture Proxy、确定性 loopback 上游、1 Turn / 3 Request、HTTP 400 原文与 exact provenance；
- 结果：Request 2 被上游拒绝，Request 3 修正后得到最终回答；
- 限制：`compatibility_note` 是人为加入的非标准测试项；它与 call id 错误同时存在，但演示不会把未知项误写成 HTTP 400 的原因；
- 画面：Codex 配色、1920×1080 完整三栏、无黑边、底部居中单句字幕；
- 隐私：固定 `/tmp/pma-protocol-debug-demo/public-project`、公开虚构文本、占位 token、无外部请求。

## 镜头脚本

| 时间 | 用户动作与画面重点 | 要证明的价值 | 标注与停留 |
| --- | --- | --- | --- |
| 00:00–00:16 | 标题卡：时间线 → 协议视图 → Raw | 普通失败日志不是完整证据链 | 16 秒；无编号 |
| 00:16–00:42 | 展开“幕后请求时间线”，点击 Request 2 `详情` | 成功结果不会抹掉中间失败 Request | 入口 1 → Request 2；右栏标题轻描边 |
| 00:42–01:08 | 点击 `协议视图`，查看未知项统计与 `compatibility_note` | 先定位协议层级，不猜未知字段语义 | 标签轻描边；统计 1 降权后出现具体行 2 |
| 01:08–01:30 | 点击 `完整请求`，搜索 `compat-v2-preview` | 未知 schema 项仍在 Raw 中保留 | 搜索 1 → 结果 2 交叉淡出 |
| 01:30–01:58 | 搜索 `call_list_`，比较 input 1 与 input 3 | 同屏发现只差一个字符的 call id | 正确值 1 降权后出现错误值 2 |
| 01:58–02:26 | 从协议视图打开 `完整下行`，切换 Response `原文` | 上游响应给出错误 code、param 与 HTTP 400 | error 1 降权后出现 capture 2 |
| 02:26–02:50 | 回到 `完整请求` 底部查看 provenance | 区分 exact 捕获与摘要推断 | request fidelity 1 降权后出现 response fidelity 2 |
| 02:50–03:15 | 打开 Request 3，使用同一 Raw 搜索 | 使用同一条件验证修正，不只相信重试成功 | 调用 1 降权后出现结果 2 |
| 03:15–03:43 | Request 3 `协议视图` | 未知项消失、下行 completed、最终回答存在 | 上行 1 降权后出现下行 2 |
| 03:43–03:58 | 结尾卡：时间线、协议、Raw、provenance、修正验证 | 形成可复述、可重复的排错顺序 | 15 秒；无编号 |

## 完整旁白

### 00:00–00:16　摘要不够，就回到原始证据

普通日志往往只告诉你请求失败，却没有把错误请求、原始字段和上游响应放在一起。下面用一个故意写错 call id 的最小例子，看看怎样从 PMA 时间线一路追到协议视图、Raw 和修正后的请求。

### 00:16–00:42　先在时间线找到被折叠的 Request 2

任务本身只是列目录。第一次请求得到工具调用，第三次请求已经修正并给出答案；真正失败的第二次请求被归入幕后请求时间线。展开它，再点详情，右栏明确显示当前查看的是 Request 二，而不是成功的 Request 三。

### 00:42–01:08　协议视图先告诉你哪一层异常

切到协议视图，PMA 按这次 Responses 形状请求中捕获到的 input 原始顺序展示四项上行。顶部统计其中一个未知项；再往下看，第三项是人为加入的非标准 compatibility note，并标记 Schema 未识别。这里能定位未知项所在的 input 层级，但协议摘要不会把它冒充官方 schema，也不会推断它造成了四百错误。

### 01:08–01:30　Raw 搜索证明未知字段没有丢失

打开完整请求，在当前 Raw 区块搜索固定标记 compat v2 preview。结果同时给出 input 二整项和精确字段路径 input 二 trace marker。协议视图不认识它的语义，但 Capture 没有静默丢弃它；兼容层新增字段仍然可以被找到和引用。

### 01:30–01:58　同一请求里直接比较正确和错误 call id

把查询换成 call list，四条结果同时出现。前两条来自最初的 function call，结尾是 directory；后两条来自 function call output，结尾却是 direct 零 ry。它们只差一个字符，但路径清楚说明一个属于 input 一，另一个属于 input 三。

### 01:58–02:26　Response 原文给出上游拒绝原因

再从协议视图打开完整下行，并切到原文。错误对象直接写明：没有找到 call list directory 的工具结果，却收到了 call list direct 零 ry；code 是 invalid tool output，参数位置是 input 三 call id。下方 response capture 同时记录 HTTP 四百和实际捕获字节。

### 02:26–02:50　provenance 说明这份证据有多可靠

错误内容之外，还要确认这份证据来自哪里。完整请求底部显示 transport 是 capture proxy；上行 request 的 fidelity 是 exact，下行 response 同样是 exact，关联方法来自同一个 Capture 生命周期。换句话说，这不是根据摘要猜出的错误，而是同一次代理交换中的请求和响应。

### 02:50–03:15　修正后再次搜索，不再出现错误拼写

切到 Request 三，再搜索相同前缀。最初调用和后续工具结果现在都使用 call list directory；结果路径也从 input 三回到 input 二，因为未知兼容项已经移除。使用同一搜索条件比较修正前后，比只相信终端里的重试成功更可靠。

### 03:15–03:43　最后回到协议视图确认闭环

最后回到 Request 三的协议视图。上行只剩用户消息、function call 和匹配的 function call output，未知项计数已经消失；下行状态是 completed，并出现最终 Assistant 消息。这里验证的不只是错误不再出现，而是修正后的完整协议闭环确实成功。

### 03:43–03:58　形成可重复的协议排错顺序

完整顺序是：先在时间线定位异常 Request，用协议视图找到层级，再到 Raw 和 Response 核对字段与错误，最后检查 provenance 并用修正后的请求验证。PMA 负责把证据连起来，但不会替你猜测协议里没有写明的原因。

## 重生成

```bash
node scripts/protocol-raw-debug-demo.mjs
```

脚本会创建固定虚构目录，启动确定性 loopback 上游与临时 Viewer，并通过真实 Capture Proxy 依次发送工具调用、错误工具结果和修正后的工具结果。Session 描述、SQLite 与上游请求日志留在 Git 忽略的 `tmp/protocol-raw-debug-demo/`，便于采集期间复核；保持脚本运行并在 1920×1080 浏览器中操作 Viewer，完成后按 `Ctrl-C` 停止本地服务。
