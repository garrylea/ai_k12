# 辅学图片两阶段流程 + 错误重试 + 错误信息人类可读 设计文档

> 日期：2026-08-09
> 关联：`docs/K12智学系统-AI辅导流程详细设计.md`、`docs/superpowers/plans/2026-08-07-auxiliary-multi-question-disambiguation.md`（多题澄清，本设计的图片两阶段会将其从"纯 prompt 驱动"改为"结构化状态机驱动"）、`docs/superpowers/specs/2026-08-02-auxiliary-track-design.md`
> 实测依据：2026-08-09 直接打 dashscope API 实测 qwen-vl-max / qwen3-vl-plus / qwen3.7-max 的 thinking 与 JSON 能力（结论见 §1.3）

---

## 1. 背景与问题

辅学轨当前在图片场景存在三个问题，本设计一并解决：

### 1.1 图片无思考链 + 题目不入库
- 图片辅导走 `qwen-vl-max`（[model-router.ts:38](../../apps/server/src/ai-core/infra/model-router.ts) hasImage 覆写）。
- 实测：`qwen-vl-max` **不支持 thinking**（`enable_thinking` 报错 `thinking_budget must be positive and not greater than 0`，流式无 `reasoning_content`）-> 图片场景无实时思考链、历史无思考过程。
- 实测：`qwen-vl-max` 支持 JSON，但在实际长辅导 prompt（[auxiliary.md](../../apps/server/src/ai-core/prompts/tutoring/math/auxiliary.md)，含"转录不得用 json"与"输出 json"冲突指令 + 苏格拉底式以提问收尾）下**指令跟随不可靠**，常跳过末尾 JSON 块 -> `parseContent` 抽不到 -> `ingestStructuredQuestion` 不触发 -> 图片题不入 `questions` 库（dlg 30 实证）。
- 纯文本走 `qwen3.7-max`（reasoner），思考链 + JSON 入库均正常。

### 1.2 出错无重试
- 大模型出错时，前端只在气泡里写 `[生成中断]`/`[网络异常]`，无重试入口；用户只能重新打字发送。

### 1.3 出错信息不可读
- ai-core 有完整错误分类（[errors.ts](../../apps/server/src/ai-core/infra/model-client/errors.ts) 11 个子类 + `buildHint`），但 [ai.service.ts mapLLMError](../../apps/server/src/modules/ai/ai.service.ts) 把它抹平成 3 句通用文案（1005/5001/5000），`buildHint` 与 providerCode 丢弃。
- 前端 [useAuxChat](../../apps/web/src/hooks/useAuxChat.ts)：SSE error 事件 -> `updateLastAssistant('[生成中断]…')`；REST 兜底失败 -> `[网络异常]`，且 `catch` 把 `ApiError(code,message)` 整个吞掉。从不弹 toast，用户看不到"欠费/网络不通"等具体原因。

### 1.4 模型能力实测结论（2026-08-09，直连 dashscope compatible-mode）

| 模型 | thinking | JSON | 图片 | 备注 |
|---|---|---|---|---|
| `qwen-vl-max`（当前图片模型） | ❌ 不支持（参数报错） | ✅ 但长 prompt 下不可靠 | ✅ | |
| `qwen3-vl-plus` | ✅ 需显式 `enable_thinking=true`（默认关） | ✅ 可靠（长 prompt 实测通过） | ✅ | 本设计转录阶段用它，**暂不开 thinking** |
| `qwen3.7-max`（当前文本模型） | ✅ 默认带 reasoning_content | ✅ 可靠 | ❌ | 辅导阶段继续用它 |

> `qwen3-vl-max` 在本账号不存在；`qwen-vl-max-latest`/`qwen2.5-vl-72b-instruct` 等是 Access denied。故转录阶段用 `qwen3-vl-plus`。

---

## 2. 需求（已与用户确认，19 条决策全锁定）

### 需求1｜图片两阶段 + 人工确认
图片 -> `qwen3-vl-plus`（不开 thinking）提取：题目文本正常输出，几何图形描述用括号括起来（必须准确、与题意一致）->
- 多道题：问"你想解决哪道题?请告诉我"；学生只能选一道；若说"全部"-> 回"每次只能帮你解决一道题哟，还是来选一道吧！"。
- 单道题（或多题选中后）：把题输出给学生 + 说"你问的是这道题吧？" -> 学生确认后 -> 交给 `qwen3.7-max` 走统一辅导流程（思考链 + JSON 入库）。

### 需求2｜错误重试
大模型出错时，对话框出错处可点"重试"，用上一条提示词重新请求；只有最后一个问题能重试。

### 需求3｜错误信息人类可读
访问大模型出错时，把错误翻译成人类可读信息发给前端显示（欠费、网络不通等）。

### 决策清单（全部已确认）
| # | 决策 |
|---|---|
| 1 | 多题选中后也走"你问的是这道题吧？"确认，流程统一 |
| 2 | 确认用前端按钮（"确认"/"重新识别"），不依赖自然语言理解 |
| 3 | 转录不对时支持打字改正 |
| 4 | "你问的是这道题吧？"等固定文案由前端产生，VL 只输出转录结果 |
| 5 | 图片带指明文字（如"解第7题"）则跳过多题询问，直接定位+确认 |
| 6 | 几何图准确性：强化 VL 转录 prompt + 学生确认双重保障 |
| 7 | 图片无法识别 -> "无法识别，请重新拍摄"，让学生重传 |
| 8 | 转录阶段无 thinking、辅导阶段有 thinking，接受 |
| 9 | 重试 = 前端重新调用发送接口（复用流式），无新端点 |
| 10 | 两阶段下只重做出错阶段（转录错重转录、辅导错重辅导） |
| 11 | 出错消息不落库；刷新回到"上一条学生消息待重试"状态；重试成功才落库 |
| 12 | 重试次数不限，每次失败更新错误文案 |
| 13 | 错误展示以对话框内为主（错误气泡+重试按钮），严重错误（欠费/鉴权）额外弹 toast |
| 14 | 区分可重试（网络/超时/限流/服务错误）与不可重试（欠费/鉴权/内容违规）；不可重试隐藏重试按钮 |
| 15 | 错误文案具体+可操作 |
| 16 | 三需求主线/辅线都适用（主线无图片上传，但重试+错误展示通用） |
| 17 | safety guard 放在文本辅导阶段（转录阶段不管离题） |
| 18 | 文本模型看整段对话历史（含转录+确认） |
| 19 | 实施顺序：3（错误展示）-> 2（重试）-> 1（图片两阶段） |
| 20 | 多题选择意图识别用 `deepseek-v4-flash` LLM 分类（select/all/unclear），不用规则正则（"全部"表达多样，规则覆盖不全；2026-08-09 确认） |

---

## 3. 总体架构

```
学生发图片 + 文字
      |
      v
[转录阶段] qwen3-vl-plus (无 thinking) -- 只做 OCR + 几何图描述
      |   输出 JSON: { recognizable, problems:[{text}] }
      |   后端按 problems.length 决定:
      |     不可识别  -> 错误"无法识别，请重新拍摄" (可重传)
      |     多道      -> 前端列表 + "你想解决哪道题?请告诉我" (flow_state=awaiting_selection)
      |     单道      -> 前端展示题 + "你问的是这道题吧?" + [确认/重新识别] (flow_state=awaiting_confirmation)
      v
[学生交互] 选哪道 / 确认 / 打字改正 / 重新识别
      |   (前端按钮驱动; "全部"->固定文案拒绝)
      v
[辅导阶段] qwen3.7-max (带 thinking) -- 走现有苏格拉底辅导
          |   输入: 已确认的转录题干 (在对话历史里)
          |   输出: reasoning 流 + content 流 + 内联 JSON 块
          v
     parseContent 抽 JSON -> ingestStructuredQuestion 入 questions 库
```

错误与重试是横切基础设施，贯穿所有阶段：
- 任何阶段大模型出错 -> 结构化错误（code+message+retryable）-> 前端错误气泡 +（严重时）toast。
- 可重试错误 -> 气泡上有"重试"按钮，只重做出错阶段。

---

## 4. 需求3：错误分类与人类可读映射（基础设施，先做）

### 4.1 错误码表

新增一个共享映射 `mapLLMErrorToClient(err)`，把 [errors.ts](../../apps/server/src/ai-core/infra/model-client/errors.ts) 的 11 个子类映射到 `{ code, message, retryable }`。`ai.service.ts mapLLMError` 与流式 error 事件统一调用它。

| 错误类 (errors.ts) | 触发 HTTP/状态 | code | 文案（人类可读） | retryable |
|---|---|---|---|---|
| `InsufficientQuotaError` | 402 / 429-quota / 400-arrearage | 1005 | AI 服务额度已用完，请联系老师充值 | false |
| `AuthenticationError` | 401 | 1006 | AI 服务鉴权失败，请联系管理员 | false |
| `PermissionError` | 403 | 1007 | AI 服务无访问权限，请联系管理员 | false |
| `ResourceNotFoundError` | 404 | 1002 | AI 模型不存在，请联系管理员 | false |
| `ContentFilteredError` | 406 / SAFETY | 1010 | 内容不符合规范，请调整后重试 | false |
| `RequestTooLargeError` | 413 | 1011 | 请求内容过大，请精简后重试 | false |
| `ValidationFailedError` | 400 / 422 | 1001 | 请求参数有误，请检查后重试 | false |
| `RateLimitError` | 429（非 quota） | 1008 | 请求过于频繁，请稍后重试 | true |
| `TimeoutError` | 408 / 0(网络/abort) | 1009 | AI 响应超时，请重试 | true |
| `ServerError` | 5xx | 5001 | AI 服务暂时不可用，请稍后重试 | true |
| 网络不通（status 0，非 abort） | 0 | 1012 | 网络连接失败，请检查网络后重试 | true |
| 未知（LLMClientError 兜底） | - | 5000 | AI 服务异常，请稍后重试 | true |

> 区分"网络不通(1012)"与"超时(1009)"：`classifyError` 对 DNS/连接失败归一 status=0 -> TimeoutError；本设计在 `mapLLMErrorToClient` 里按 `err.message`/abort 标志再细分（abort=用户停止，不报错；真超时=1009；连接失败=1012）。若难区分，合并为 1009 也可接受。

### 4.2 后端改动

**`apps/server/src/ai-core/infra/model-client/errors.ts`**（或新建 `error-mapping.ts`）
- 新增 `mapLLMErrorToClient(err: unknown): { code: number; message: string; retryable: boolean }`，按上表用 `err instanceof XxxError` 分支。
- 导出供 service 层与 capability 层共用。

**`apps/server/src/modules/ai/ai.service.ts`**
- `mapLLMError` 改为调用 `mapLLMErrorToClient`，把 `{ code, message, retryable, dialogueId }` 放进 HttpException response。`retryable` 作为 extra 字段透传（[http-exception.filter.ts](../../apps/server/src/common/filters/http-exception.filter.ts) 已透传 `...rest`）。
- 流式 `tutorStream`：capability 现在yield 的 `{type:'error', message}` 改为 `{type:'error', code, message, retryable}`（见下 capability 改动）。

**`apps/server/src/ai-core/capabilities/tutoring.capability.ts`**
- `tutorStream` 的 mid-stream catch（现 ~line 150-158）：把 `yield { type:'error', message: err.message }` 改为 `const e = mapLLMErrorToClient(err); yield { type:'error', ...e }`。注意：mid-stream 错误不落库（保持现状的"best-effort persist partial"），但要把错误结构化发给前端。
- `StreamEvent` 的 error 类型扩展为 `{ type:'error'; code:number; message:string; retryable:boolean }`。

**`apps/server/src/modules/ai/ai.controller.ts`**
- `tutorStream` 的 catch（pre-stream HttpException）：payload 里取 `retryable` 一并发送 `{type:'error', code, message, retryable}`。

### 4.3 前端改动

**`apps/web/src/services/api.ts`**
- `ApiError` 增加 `retryable?: boolean` 字段；`fetchApi` 解析响应时把 `retryable` 带上。

**`apps/web/src/store/chatStore.ts`**
- `ChatMessage` 增加 `error?: { code:number; message:string; retryable:boolean; stage?: 'transcribe'|'tutor' }`。
- 新增 `setLastAssistantError(err)` action：把最后一条 assistant 消息标记为 error 状态（content 清空，设 error）。
- `appendLastAssistant` 等不变。

**`apps/web/src/hooks/useAuxChat.ts`**
- `streamTutor` 的 error 事件处理：从 `updateLastAssistant('[生成中断]…')` 改为 `setLastAssistantError({code, message, retryable, stage})`。
- `fallbackToRest` 的 catch：不再吞 `ApiError`；把 `err.code/err.message/err.retryable` 经 `setLastAssistantError` 落到气泡。
- 流式启动失败（`!res.ok`）：从 response 体解析 `{code,message,retryable}`（SSE 路径 pre-stream 错误也可能以非 200 + JSON 返回，需兼容）。

**`apps/web/src/components/business/AuxChatPanel.tsx`**
- 渲染：若 `m.error`，渲染**错误气泡**（醒目样式，如浅红底）= 错误文案 + （若 `retryable`）"重试"按钮 + （若不可重试）仅文案与建议。不再渲染 `[生成中断]` 文本。
- 错误气泡的"重试"按钮 -> 调 `useAuxChat.retry()`（见 §5）。

**`apps/web/src/components/base/Toast.tsx`**
- 严重错误（code 1005/1006/1007，即欠费/鉴权/权限）在 `setLastAssistantError` 时**额外** `toast('error', message)`。

### 4.4 不落库策略（决策11）
- 出错的 assistant 消息只在内存 store（`chatStore`），不写 `ai_messages`。
- 用户消息（已发送）正常落库。
- 刷新页面 -> 历史加载时，若最后一条是 user 消息且无 assistant 回复 -> 前端识别为"待重试"状态，在该 user 消息下显示"重试"入口（见 §5.3）。

---

## 5. 需求2：重试机制

### 5.1 retry 语义
- `useAuxChat.retry()`：取出"最后一条 user 消息 + 其 attachments + 出错阶段"，重新走该阶段的发送流程。
- 移除当前的错误气泡（或待重试标记），重新 append 一条 assistant 占位（streaming:true），重新调模型。
- 只对"最后一个问题"生效（决策2）。UI 上只有最后一条错误气泡/待重试 user 消息有重试按钮。

### 5.2 两阶段下的分阶段重试（决策10）
- 记录出错阶段 `stage`（在 `error.stage`）：
  - `'transcribe'`：转录阶段出错 -> retry 重新发图片走转录。
  - `'tutor'`：辅导阶段出错 -> retry 重新发"确认"触发辅导（转录结果已在历史里，不重做转录）。
- `retry()` 按 `stage` 决定重发什么：
  - transcribe 重试 -> 用原始 image attachment + 原始文字重新调转录。
  - tutor 重试 -> 重新发"确认该题"触发 qwen3.7-max 辅导。

### 5.3 刷新后的待重试状态（决策11）
- 历史加载（`getMessages`）：若最后一条是 user 消息、无后续 assistant -> 标记该对话为"末条待重试"。
- 该 user 消息渲染时显示"重试"按钮 -> 调 `retry()`。
- 重试成功 -> 正常落库 assistant 回复。
- 重试又失败 -> 更新错误文案（决策12），仍可重试。

### 5.4 改动点
- `useAuxChat`：新增 `retry()`；`send` 内部把"可重试上下文"（最后 user 消息内容/attachments/stage）存到 ref，供 retry 取用。
- `AuxChatPanel`：错误气泡 + 末条待重试 user 消息，渲染"重试"按钮 -> `retry()`。
- 不新增后端端点（决策9）。

---

## 6. 需求1：图片两阶段 + 人工确认

### 6.1 对话状态机（后端 flow_state）

`ai_dialogues` 新增 `flow_state` 字段，取值：

| flow_state | 含义 |
|---|---|
| `idle` | 无图片流程进行中（正常文本辅导或空闲） |
| `awaiting_selection` | 多题图片已转录，等学生选哪道 |
| `awaiting_confirmation` | 单题（或已选中题）已转录，等学生确认 |

转移：
```
idle + 图片
  -> 不可识别:          回 idle, 返回"无法识别，请重新拍摄"(可重传)
  -> 单题:              awaiting_confirmation
  -> 多题:              awaiting_selection
  -> 图片+指明文字(决策5): 定位到那道 -> awaiting_confirmation

awaiting_selection + 学生回复（free text）
  -> [deepseek-v4-flash 意图分类] select+index:  awaiting_confirmation (pending_question=选中题)
  -> [分类] all:   保持 awaiting_selection, 回"每次只能帮你解决一道题哟，还是来选一道吧！"
  -> [分类] unclear: 保持, 回"没听清，请告诉老师题号（如第1题）"

awaiting_confirmation + 学生[确认]
  -> qwen3.7-max 辅导,  flow_state -> idle
awaiting_confirmation + 学生[重新识别]
  -> 重新转录 -> awaiting_selection/awaiting_confirmation
awaiting_confirmation + 学生打字改正(决策3)
  -> 用改正文本覆盖 pending_question, 保持 awaiting_confirmation, 重新展示+"你问的是这道题吧？"
```

> safety guard（决策17）只在 `awaiting_confirmation -> 辅导` 时跑（转录/选择/确认阶段不判离题）。

### 6.2 转录阶段（qwen3-vl-plus，无 thinking）

**新增 prompt** `apps/server/src/ai-core/prompts/tutoring/math/transcribe.md`：
- 角色：题目图片识别器。
- 要求：
  1. 把题目文本原样转录（纯文本）。
  2. 几何图形用括号描述，**必须准确、与题意一致**（标注已知/求证/关键几何关系，用规范术语）。
  3. 多道题逐题编号。
  4. 模糊/非题目 -> `recognizable:false`。
- 输出 **JSON**（qwen3-vl-plus JSON 可靠，实测通过）：
  ```json
  { "recognizable": true, "problems": [ { "index": 1, "text": "第7题：在⊙O中，AB是直径，CD是弦，AB⊥CD于点E，CD=24，BE=8。求⊙O的半径。（图中⊙O为圆，AB为过圆心的直径，弦CD垂直于AB于点E）" } ] }
  ```
- 不开 `enable_thinking`（决策8）。

**新增能力方法** `TutoringCapability.transcribeImage(attachments, signal)`：
- 构造多模态消息（text prompt + image_url），调 `modelClient.streamChat` 或 `chat`（转录可非流式，结果一次性返回；若流式则前端显示"识别中…"spinner）。
- 路由到 `qwen3-vl-plus`（model-routes.yaml 新增该模型配置）。
- 解析 JSON -> `{ recognizable, problems[] }`。

**model-routes.yaml**：新增 `qwen3-vl-plus` 模型配置（provider=qwen, contextWindow=32768, maxOutputTokens=8192, supportsStreaming=true, enableThinking=false 标志位）。新增 `transcribe` 场景路由（primary=qwen3-vl-plus）。

**model-router.ts**：`hasImage` 覆写**移除**（辅导不再走 VL）；新增 `transcribe` 场景路由到 qwen3-vl-plus。

### 6.3 转录阶段的执行与编排

`ai.service.ts` / `tutoring.capability.ts prepare()` 改造（按 flow_state 分支）：

- **flow_state=idle + hasImage**：
  1. 调 `transcribeImage` -> `{recognizable, problems}`。
  2. 不可识别 -> 持久化 user(图)+assistant(固定"无法识别，请重新拍摄")，flow_state 保持 idle，返回该文案（前端让重传）。
  3. 单题（problems.length==1）或图片文字已指明某题 -> 持久化 user(图)+assistant(转录文本)，设 `pending_question=problems[0].text`，flow_state=awaiting_confirmation。返回转录文本 + `stage:'transcribe_done'`（前端展示题 + "你问的是这道题吧？" + 确认按钮）。
  4. 多题 -> 持久化 user(图)+assistant(编号转录列表)，flow_state=awaiting_selection。返回列表 + `stage:'select'`（前端展示 + "你想解决哪道题?请告诉我"）。

- **flow_state=awaiting_selection + 学生回复**：
  - 调 `classifySelection(学生原话, problems)`（deepseek-v4-flash，JSON 输出 `{intent:'select'|'all'|'unclear', index?}`）。
  - `select` + index -> `pending_question=problems[index].text`，flow_state=awaiting_confirmation，持久化 user(选)+assistant(选中题转录)，返回选中题 + `stage:'transcribe_done'`。
  - `all` -> 固定文案"每次只能帮你解决一道题哟，还是来选一道吧！"，保持状态（"全部"的多种表达由 LLM 归一，不靠规则）。
  - `unclear` -> "没听清，请告诉老师题号（如第1题）"，保持状态。

- **flow_state=awaiting_confirmation + 学生确认（按钮）**：
  - 走现有辅导流程：`pending_question` 作为题干进入 prompt 上下文，路由 qwen3.7-max（正常文本路由），safety guard 跑，`tutorStream` 流式输出 reasoning+content+JSON。flow_state=idle。
  - 持久化 user(确认)+assistant(辅导)。
  - 文本模型看整段历史（决策18），转录+确认都在历史里。

- **flow_state=awaiting_confirmation + 重新识别**：重跑转录（回到 idle+hasImage 分支）。
- **flow_state=awaiting_confirmation + 打字改正**：用学生输入覆盖 `pending_question`，重新展示+"你问的是这道题吧？"，保持状态。

> 流式：转录阶段若用流式，前端显示"识别中…"（无思考链）；辅导阶段流式 reasoning+content（有思考链）。前端按返回的 `stage` 决定渲染。

### 6.4 与现有"多题澄清 prompt"的关系
[2026-08-07 多题澄清计划](./2026-08-07-auxiliary-multi-question-disambiguation.md) 把多题处理放在辅导 prompt 里（让单一 VL 模型自己问"想先看哪道"）。本设计改为**结构化状态机**（VL 只转录成 JSON，后端驱动选择/确认）。因此：
- [auxiliary.md](../../apps/server/src/ai-core/prompts/tutoring/math/auxiliary.md) 的"多题处理""图片输入处理"两段：图片场景下不再由辅导模型承担（qwen3.7-max 看不到图，看到的是已确认的转录题干）。需精简：移除图片转录/多题澄清指令，保留纯文本苏格拉底辅导 + JSON 输出规则。
- 多题 force-single 语义保留，但由状态机 + 规则解析实现（更可靠，不依赖 LLM 遵循）。

---

## 7. 数据模型变更

`ai_dialogues` 新增字段（`tools/db/schema.sql` + DB 设计文档同步）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `flow_state` | varchar(20) NOT NULL DEFAULT 'idle' | 图片流程状态机 |
| `pending_question` | text NULL | 已转录、待确认的题干文本 |
| `pending_questions` | text NULL | 多题时的全部转录 JSON（`[{index,text}]`），供选择时取用 |

> 无 migration 框架，开发库手 ALTER（验收步骤注明）。

`ai_messages.type` 复用/扩展：新增 `transcription`（转录回复）、`selection`（选中题展示）值，便于前端按类型渲染固定文案。

`questions` 表：不变（入库路径不变，仍在辅导首条回复的 JSON 块，只是改由 qwen3.7-max 产出 -> 图片题也能入库了）。

---

## 8. API 变更

复用 `POST /api/ai/tutor/stream`，不新增端点（决策9）。响应（SSE 事件）扩展：

- 转录/选择/确认阶段返回新事件类型：
  - `{type:'flow', stage:'select', problems:[...]}` —— 多题，前端展示列表 + 固定文案。
  - `{type:'flow', stage:'confirm', question:'...'} ` —— 单题/已选，前端展示题 + "你问的是这道题吧？" + 确认按钮。
  - `{type:'flow', stage:'unrecognizable'}` —— 无法识别。
- error 事件扩展：`{type:'error', code, message, retryable}`（见 §4）。
- 辅导阶段：`reasoning`/`content`/`done` 事件不变。

`docs/api/openapi.yaml` + `docs/API接口与数据流设计文档.md` 同步：
- §4 tutor/stream 端点响应事件补 `flow` / 扩展 `error`（code/message/retryable）。
- 新增错误码 1005-1012 说明。
- 数据流 §6 补"图片两阶段"流。

---

## 9. 前端 UX

- **转录中**：assistant 气泡显示 spinner"识别中…"（无思考链）。
- **多题选择**：assistant 气泡渲染编号转录列表 + 固定文案"你想解决哪道题?请告诉我"。学生用输入框自由回复（"第2题"/"都要"/"全做"…）；后端用 deepseek-v4-flash 意图分类（select/all/unclear），"全部"类表达统一回固定拒绝文案。
- **单题确认**：assistant 气泡渲染转录题 + 固定文案"你问的是这道题吧？" + 两个按钮：`确认` / `重新识别`；并支持学生在输入框打字改正（改正后重新展示+确认）。
- **辅导**：现有 ReasoningBlock（思考链，折叠可展开）+ content 流 + JSON 剥离。
- **错误气泡**：醒目样式（浅红底）+ 人类可读文案；`retryable=true` 显示"重试"按钮；`retryable=false`（欠费/鉴权等）仅文案+建议，无按钮；严重错误额外 toast。
- **末条待重试**：历史加载后末条 user 消息无回复 -> 该消息下显示"重试"。

复用 [Toast](../../apps/web/src/components/base/Toast.tsx)、[AuxChatPanel](../../apps/web/src/components/business/AuxChatPanel.tsx) 现有结构；固定文案集中常量化，便于后续调整。

---

## 10. 代码改动清单

### 后端
| 文件 | 改动 |
|---|---|
| `ai-core/infra/model-client/errors.ts`（或新建 error-mapping.ts） | 新增 `mapLLMErrorToClient` |
| `modules/ai/ai.service.ts` | `mapLLMError` 调用映射、透传 retryable；`prepare`/`tutorStream` 按 flow_state 分支编排转录/选择/确认/辅导 |
| `ai-core/capabilities/tutoring.capability.ts` | 新增 `transcribeImage`、`classifySelection`（deepseek-v4-flash 意图分类）；`tutorStream` error 事件结构化；`StreamEvent` 扩展 flow/error |
| `ai-core/infra/model-router.ts` | 移除 hasImage 辅导覆写；新增 transcribe 场景路由 |
| `ai-core/model-routes.yaml` | 新增 qwen3-vl-plus 模型 + transcribe 场景（classifySelection 复用 structuring 路由 deepseek-v4-flash） |
| `ai-core/prompts/tutoring/math/transcribe.md` | 新建转录 prompt |
| `ai-core/prompts/tutoring/math/select.md` | 新建选择意图分类 prompt（输入学生原话+题数，输出 `{intent,index?}`） |
| `ai-core/prompts/tutoring/math/auxiliary.md` | 精简图片/多题段（改由状态机承担） |
| `database/repositories/ai-dialogues.repo.ts` | 读写 flow_state / pending_question / pending_questions |
| `database/repositories/ai-messages.repo.ts` | type 新增 transcription/selection（如需） |
| `modules/ai/dto/tutor.dto.ts` | 如需，加 selection/confirm 相关字段（尽量复用 message+dialogueId） |
| `common/filters/http-exception.filter.ts` | 已透传 extra，确认 retryable 透传 |
| `tools/db/schema.sql` | ai_dialogues 加 3 字段 |

### 前端
| 文件 | 改动 |
|---|---|
| `services/api.ts` | ApiError 加 retryable；tutor/stream 事件类型补 flow/扩展 error |
| `store/chatStore.ts` | ChatMessage 加 error 字段；`setLastAssistantError`；末条待重试标记 |
| `hooks/useAuxChat.ts` | error 走 setLastAssistantError；新增 `retry()`；按 stage 重做；flow 事件处理（select/confirm/unrecognizable） |
| `components/business/AuxChatPanel.tsx` | 错误气泡 + 重试按钮；flow 渲染（转录列表/确认按钮/识别中）；末条待重试 |
| `components/business/AuxInputBar.tsx` | 确认按钮场景下输入框行为（确认/改正/选择） |

### 文档
| 文件 | 改动 |
|---|---|
| `docs/api/openapi.yaml` | tutor/stream 事件 + 错误码 |
| `docs/API接口与数据流设计文档.md` | §4/§6 同步 + 版本日志 |
| `docs/K12智学系统-数据库设计文档.md` | ai_dialogues 加字段 |
| `docs/K12智学系统-AI辅导流程详细设计.md` | 图片两阶段流程 + 错误码表 |
| `docs/superpowers/specs/2026-08-02-auxiliary-track-design.md` | 图片流程改两阶段、多题改状态机 |
| `CLAUDE.md` | 记录 qwen-vl-max 不支持 thinking、qwen3-vl-plus 需 enable_thinking、图片两阶段、错误码 |

---

## 11. 测试要点

- **错误映射**：构造各错误子类 -> 断言 code/message/retryable；前端错误气泡 + toast（严重）+ 重试按钮（可重试）渲染。
- **重试**：模拟流式 error -> 点重试 -> 重新发送成功；刷新后末条待重试 -> 重试。
- **两阶段-单题**：传图 -> 转录 -> "你问的是这道题吧？" -> 确认 -> qwen3.7-max 辅导（有思考链 + JSON 入库）。
- **两阶段-多题**：传图 -> 列表 -> "全部"被拒 -> 选第2题 -> 确认 -> 辅导。
- **两阶段-指明**：图+"解第7题" -> 跳过选择直接确认。
- **两阶段-纠正/重识别**：打字改正 -> 重新确认；重新识别 -> 重转录。
- **不可识别**：模糊图 -> "无法识别，请重新拍摄" -> 可重传。
- **入库**：图片题辅导首条回复的 JSON 块进 `questions`（source=auxiliary），历史可回看思考链。
- **回归**：纯文本辅导不受影响（思考链 + JSON 入库）；主线辅导重试/错误展示生效。

---

## 12. 实施顺序（决策19）

1. **P3 错误展示**：错误码表 + `mapLLMErrorToClient` + 流式/REST 透传 + 前端错误气泡/toast/不落库。
2. **P2 重试**：`retry()` + 分阶段重做 + 末条待重试。
3. **P1 图片两阶段**：transcribe prompt + 能力 + 状态机 + 前端 flow 渲染 + DB 字段 + 移除 hasImage 覆写 + auxiliary.md 精简。

每阶段独立可验收；P3、P2 是基础设施，P1 依赖前两者（图片流程也会用到错误展示与重试）。

---

## 13. 风险与权衡

- **两次 LLM 调用**（图片）：转录 + 辅导，延迟与成本上升。权衡：换得思考链一致 + JSON 可靠 + 行为统一（决策一致认可）。
- **qwen3-vl-plus 转录准确性**：几何图描述可能不准。缓解：强化 prompt + 学生确认/打字改正（决策3/6）。后续可考虑让 qwen3.7-max 在辅导时也能指出转录疑点。
- **状态机复杂度**：flow_state 引入多分支。缓解：状态集中在一处（`prepare` 按分支），前端按 stage 渲染，规则解析题号用正则（确定性）。
- **思考链差异**：转录无 thinking、辅导有 thinking。用户已接受（决策8）。
- **流式无自动重试**：保持现状（streamChat 不包 callWithRetry，避免重复 token），靠手动重试兜底。
- **错误不落库**：刷新后靠"末条待重试"恢复；若用户不重试直接发新消息，旧的未答 user 消息留在历史（可接受，等同于正常未答）。

---

## 14. 待定 / 后续

- 转录阶段是否也流式（vs 非流式一次性）：实现时定，倾向非流式（转录快、简化前端）。
- `qwen3-vl-plus` 的 maxOutputTokens/thinking_budget 默认值：实现时按实测调。
- 多题选择意图分类用 deepseek-v4-flash（select/all/unclear）；复杂表述（"中间那道"）由 LLM 归到 select+index 或 unclear，不再靠正则。
- 后续若 dashscope 上线 `qwen3-vl-max`（thinking VL max 档），可评估单阶段方案回归。
