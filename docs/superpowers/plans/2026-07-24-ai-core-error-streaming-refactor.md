# ai-core 错误模型重构 + 默认流式 + reasoning 处理

日期：2026-07-24 ｜ 分支：feat/ai-agent-hub-mvp

## 目标（用户三要求）
1. 将 `../llm-client.js` 的错误处理体系加入 AI-Agent 设计文档
2. ai-core 各模型连接采用 llm-client.js 的出错机制（错误子类 + classifyError + callWithRetry full-jitter + Retry-After）
3. 连接默认流式，处理 thinking（reasoning_content）；reasoning 全部透传到 capability 响应

## 已确认决策
- **gemini 流式暂缓**：kimi/qwen/deepseek 默认流式；gemini 保留非流式 chat + streamChat 抛 TODO（待配 GEMINI_API_KEY 后实现 streamGenerateContent）
- **reasoning 全部透传**：所有 capability 响应加 `reasoning` 字段

## 参考文件
- `../llm-client.js`：错误子类 + classifyError + callWithRetry + jitteredBackoff + parseRetryAfter
- `../kimi-chat.js`：流式 `stream:true` + `delta.reasoning_content` 读取模式

---

## A. 错误模型重构（types.ts + errors.ts）

### types.ts
- **移除**：`ModelErrorCode` enum、`ModelClientError` class、`RetryConfig` interface
- **新增错误子类**（TS 版，基于 llm-client.js，加 `modelId` 字段）：
  - `LLMClientError extends Error`（base：provider/statusCode/providerCode/retryable/retryAfterMs/hint/modelId）
  - `AuthenticationError`（401，retryable=false）
  - `InsufficientQuotaError`（402 / 429-insufficient_quota / qwen arrearage，retryable=false）
  - `PermissionError`（403，retryable=false）
  - `ResourceNotFoundError`（404，retryable=false）
  - `RequestTooLargeError`（413，retryable=false）【对应原 CONTEXT_TOO_LONG】
  - `ValidationFailedError`（400/422，retryable=false）
  - `RateLimitError`（429 限流，retryable=true）
  - `ServerError`（5xx，retryable=true）
  - `TimeoutError`（abort/网络/408，retryable=true）
  - `ContentFilteredError`（406 / gemini SAFETY，retryable=false）【ai-core 扩展，llm-client 无此类】
- **新增** `RetryOptions`：{ maxRetries, baseDelayMs, maxBackoffMs, onRetry? }

### errors.ts
- `mapHttpError` → `classifyError({ provider, status, body, headers, modelId })`：返回对应错误子类（按 llm-client classifyError 逻辑 + 406/SAFETY → ContentFilteredError）
- 新增 `parseRetryAfter(value)`：解析 Retry-After header（整数秒 / HTTP-date）
- 新增 `jitteredBackoff(attempt, baseDelay, maxBackoff)`：full-jitter `randomInt(0, cap)`
- 新增 `callWithRetry(fn, options)`：full-jitter 退避 + 遵守 Retry-After + onRetry 钩子；非 retryable 立即抛

---

## B. ModelClient 重试（model-client/index.ts）
- `chat(request)`：用 `callWithRetry` 包装。默认 `stream=true` 走流式聚合（见 C）；`stream=false` 走 `provider.chat` 非流式。错误经 classifyError 抛子类。
- `streamChat(request)`：直接转 `provider.streamChat`（真流式，供将来 HTTP 层 SSE 转发），**不套 callWithRetry**（mid-stream 重试复杂，留给调用方）。标注。
- 移除原 for 循环重试 + 旧 classifyError

---

## C. 流式 + reasoning（types.ts + kimi-client + ModelClient）

### types.ts
- `ChatResponse`：加 `reasoningContent?: string`
- `StreamChunk`：加 `reasoningContent?: string`
- `ChatRequest.stream`：已存在，默认 true

### kimi-client.ts（qwen/deepseek 继承，自动获益）
- `streamChat`：读 `delta.reasoning_content`（thinking）+ `delta.content`（回答）+ `chunk.usage`（token，尽力收）。yield `{ content, reasoningContent, finishReason }`
- `chat`（非流式，stream=false 降级）：用 `classifyError` 替代 `mapHttpError`；非流式响应也提取 reasoning_content（若有）

### ModelClient.chat 流式聚合
- 默认 stream=true：`for await` 消费 `provider.streamChat`，累加 content + reasoningContent，收 usage（最后 chunk，无则 0）。返回 ChatResponse（含 reasoningContent）
- 用 `callWithRetry` 包装整个聚合（retryable 错误重试整个流，接受重复生成代价）

### gemini-client.ts
- `chat`：用 `classifyError` 替代 `mapHttpError`
- `streamChat`：保留 `throw new Error('Gemini streaming not implemented (TODO: streamGenerateContent, needs GEMINI_API_KEY)')`
- ModelClient.chat 对 gemini：走非流式 `chat`（降级），标注

---

## D. capability 透传 reasoning
所有 capability 从 `chatResponse.reasoningContent` 取，填入响应：
- `TutoringResponse`：加 `reasoning?: string`
- `ExplanationResponse`：加 `reasoning?: string`
- `GradingResult`：加 `reasoning?: string`（非 Zod schema 字段，capability 填充）
- `VariationResponse`：加 `reasoning?: string`
- `AnalyticsResponse`：加 `reasoning?: string`
- `FallbackResponse`：加 `reasoning?: string`

---

## E. retry.yaml
- `retry`: `maxRetries/initialDelayMs/backoffMultiplier/retryableCodes` → `maxRetries/baseDelayMs/maxBackoffMs`（移除 retryableCodes—retryable 由错误子类决定；移除 backoffMultiplier 改 full-jitter）
- `timeout`: 保留（已接线）
- `streaming`: 保留（firstTokenTimeoutMs/interTokenTimeoutMs 仍声明式，可选后续接线）

---

## F. 文档同步（要求 1）

### 设计文档 docs/K12智学系统-AI-Agent中枢设计文档.md
- §3.3.3 ChatResponse/StreamChunk：加 reasoningContent 字段
- §3.3.4 统一错误码：替换 ModelErrorCode/ModelClientError 为 11 个错误子类 + classifyError 说明
- §3.3.5 重试策略：替换 RetryConfig 为 RetryOptions + callWithRetry + jitteredBackoff + parseRetryAfter
- §3.3.6 ModelClient 伪代码：用 callWithRetry + 默认流式聚合
- 新增小节：默认流式 + reasoning_content 处理（thinking 捕获与透传）
- gemini 流式 TODO 标注

### 计划文档
- `docs/superpowers/plans/2026-07-23-ai-agent-hub-mvp-implementation.md`：同步错误模型 + 流式（Types/ModelClient 章节）
- `docs/superpowers/plans/2026-07-23-ai-agent-hub-mvp.md`：同步

### CLAUDE.md
- ai-core 节"错误处理"：更新为错误子类 + classifyError + callWithRetry（替换 ModelErrorCode/mapHttpError 描述）
- 已知限制：加 gemini 流式未实现；更新相关条目
- 实现记录：加 2026-07-24 错误模型 + 流式 + reasoning 重构

---

## G. 测试
- `model-client/index.test.ts`：重写
  - mock `provider.streamChat`（流式 SSE）替代 fetch mock
  - 断言错误子类：429→RateLimitError、401→AuthenticationError、500→ServerError
  - 断言重试：retryable 重试、非 retryable 立即抛
  - 断言 reasoningContent 聚合
- `capability.test.ts`（tutoring/grading/explanation/variation/analytics）：
  - mock modelClient.chat 返回含 reasoningContent
  - 断言响应含 reasoning
- `fallback-handler.test.ts`：同步
- 新增流式 + reasoning 单测

---

## 验证
1. `npm run build`（tsc）exit 0
2. `npm test`（vitest）全绿
3. `npx tsx src/ai-core/__tests__/safety-classification.ts` 29/29（确认未破坏）
4. `npx tsx src/ai-core/__tests__/tutoring-quality.ts` 6/6 达标 + 验证 reasoning 透传（打印 reasoning）
5. 文档 grep：确认设计文档 §3.3 已替换为错误子类体系

## 风险
- 流式 usage：kimi 流式不返回 usage（kimi-chat.js 注明），cost 可能 0。接受（metrics 未接线）
- gemini 流式暂缓：gemini 走非流式降级，标注 TODO
- 测试大改：index.test.ts + capability.test.ts 重写
- 破坏性：ModelErrorCode 移除，引用它的代码/测试全改

## 不在范围
- HTTP API 层（仍待建）
- gemini streamGenerateContent 实现（暂缓）
- streaming.firstTokenTimeoutMs/interTokenTimeoutMs 接线（可选后续）
