# 辅线答疑流式输出（content + thinking 实时流）

## 目标
- content 与 reasoning 都按 token 流式输出到前端（逐字出现）。
- 折叠的「思考过程」框：流式过程中实时滚动显示**当前思考的最后一行**（作为"thinking 阶段标题"的近似），可实时点开看完整思考流，可收起。

## 现状
- 无流式端点。所有答疑走 `POST /api/ai/tutor`（REST 非流式，整包返回）；`useAuxChat` 的 WS 代码因无 gateway 从未生效，实际都走 `fallbackToRest`。
- `ModelClient.streamChat` 已存在（yield `{content, reasoningContent, finishReason}` 增量），但 HTTP 层未用。
- `TutoringCapability.tutor()` 用 `modelClient.chat`（内部聚合 streamChat 后返回整包）。
- qwen3.7-max 默认返回 `reasoning_content`，reasoning 已能拿到（只是非流式）。

## 方案

### 后端
1. **`TutoringCapability`：抽 `prepare(request)` 私有方法 + 新增 `tutorStream(request): AsyncIterable<StreamEvent>`**
   - `prepare` 复用 tutor() 的 Step 1-5（loadContext / fallback 判定 / safety / route / build prompt / 多模态 augment），返回 `{ shortCircuit?: { events: StreamEvent[]; persist?: () => Promise<void> }, promptResult?, routeResult?, context?, userAttachments? }`。tutor() 也改用 prepare（去重，保证两条路径一致）。
   - fallback / block 短路：yield 单条 content 事件 + done（不流式模型）。
   - 正常路径：`for await (chunk of modelClient.streamChat(...))` 逐块 yield `{type:'reasoning', delta}` / `{type:'content', delta}`；同时聚合 content+reasoning。
   - 流结束后：解析 structuredQuestion（Step 7）、saveMessages（Step 8）、updateFailCount（Step 9），yield `{type:'done', structuredQuestion?, fallback:false}`。
   - 错误：streamChat 无 retry，try/catch；出错 yield `{type:'error', message}`，best-effort 持久化已聚合内容。
   - `StreamEvent = { type:'reasoning'|'content'|'done'|'error'; delta?: string; structuredQuestion?: ...; fallback?: boolean }`（加到 `ai-core/types.ts`）。

2. **`AIService.tutorStream(dto, user): AsyncIterable<StreamEvent>`**
   - 复用现有 attachment 解析（fileId -> base64 dataUrl）。
   - 创建/校验 dialogue（复用现有逻辑）。
   - 转发 `tutoring.tutorStream(request)`。
   - structuredQuestion 入库（复用现有 errorBook 逻辑）放在 done 前后。

3. **`AIController`：`@Post('tutor/stream')` + `@Res() res: Response`**
   - 手动 SSE：`Content-Type: text/event-stream`，`res.write('data: ${JSON.stringify(event)}\n\n')`，结束 `res.end()`。
   - 用 POST（body 含 message + dialogueId + attachments），前端用 `fetch` + `getReader()` 读（非 EventSource，因 EventSource 只支持 GET）。
   - 保留原 `POST /api/ai/tutor`（非流式）作为兜底/重试。

### 前端
4. **`chatStore`：新增 `appendToLastAssistant({ content?, reasoning? })`**（增量追加 content 和/或 reasoning 到最后一条 assistant 消息）。

5. **`useAuxChat.send`：改走流式 fetch**
   - `fetch('/api/ai/tutor/stream', { method:'POST', headers, body, signal })` -> `response.body.getReader()` -> 解析 SSE `data:` 行 -> 按 type 调 `appendToLastAssistant({content})` / `({reasoning})`。
   - `done` -> `setIsStreaming(false)`；`error` -> 追加错误提示文案。
   - 删除从未生效的 WS 代码（wsRef / onmessage / onclose / ws.send），用流式 fetch 取代。
   - 流式 fetch 启动失败（网络/非 200）-> 回退到原 `fallbackToRest`（非流式 `/ai/tutor`）。

6. **`AuxChatPanel` / `ReasoningBlock`**
   - content 流式：`m.content` 实时增长（已支持）。
   - reasoning 流式：`m.reasoning` 实时增长。
   - **折叠态（流式中）**：显示 reasoning 最后一行（`reasoning.split('\n').filter(Boolean).pop()`），实时滚动更新 = "thinking 阶段标题"效果；旁边可保留跳动三点。
   - **展开态**：完整 reasoning 流式显示（`whitespace-pre-wrap`，自动滚到底）。
   - **流式结束后**：折叠态回到 48 字预览（现有行为）。
   - 跳动三点：`streaming && !m.content` 时在气泡内显示（reasoning 此时在折叠框里流）。

## 不做 / 取舍
- **reasoning 持久化**：thinking 落库到 `ai_messages.reasoning` 列，历史回放时映射进消息并渲染折叠「思考过程」框（`live=false`，复用 `ReasoningBlock`）。> 2026-08-05 调整：原计划「不持久化（仿 ChatGPT 习惯）」，用户反馈希望回看历史思考，故改为持久化——`SaveMessageEntry` + `saveMessages` + `tutor`/`tutorStream`（流式聚合 reasoning）均透传，`getMessages` 经 `SELECT *` 自动带回，前端 `MessageItem`/`useAuxChat` 映射。
- **"阶段标题"用启发式提取**：折叠态实时预览取 reasoning 中最近一条「非列表项（不以 `-`/`*`/`•`/`N.` 开头）、长度 ≤ 24」的行作为当前阶段标题（如 后端/前端/验证），列表项跳过使标题在整段 bullet 流入时保持稳定，找不到则回退最后一行。> 2026-08-05 调整：原「最后一行」近似会逐行轮播每个 bullet，改为启发式取阶段标题行；不改模型 CoT（避免推理质量风险），要真结构化标题仍需后续改 prompt 让模型按 `## 阶段名` 输出思考。>> 2026-08-05 二次修正：≤24 字阈值会误判短解释行为标题（如「我正据此构建清晰的节点定义和电流路径逻辑。」21 字被顶成标题导致闪烁）。改为四条联判：非列表项 + 长度 ≤ 30 + **不以句末标点（。！？；）结尾** + **不以句首词（我/通过/在此/当前/当/上/因此…）开头**。标题行无句末标点、解释行通常以。结尾且以代词/连词开头，故短解释行被稳定剔除。已用电路例（4 个标题：分析电路结构与元件关系→分析电路结构→设置电路初始状态→分析电路路径与开关状态对电压读数的影响）验证。>>> 2026-08-05 三次修正（实操定位根因）：DB `ai_messages.reasoning` 实测（hex dump 确认 0x5C 0x6E）发现 qwen3.7-max 的 `reasoning_content` 把 `\n` 当**字面量文本**（反斜杠+n 两字节）输出而非真换行，故 `split('\n')` 只切 1 段、整段被当一行，上述启发式全部失效、回退到整段内容（用户看到「每次滚动一堆内容」）。且模型实际 CoT 用「以 `：` 结尾的短行」作章节标题（`分析用户的问题：`/`解题思路通常包括：`/`引导策略：`/`草稿：`），key:value 行（`年级：9年级。`）以 `。` 结尾被排除。最终方案：①前端 `reasoning.replace(/\\n/g,'\n')` 归一化字面量换行（旧 DB 记录兜底）；②`KimiClient.chat`/`streamChat` 在源头归一化 `reasoning_content`（qwen/deepseek/kimi；gemini 不提取 reasoning_content 无需改）；③标题检测改为冒号规则：行以 `：`/`:` 结尾 + 全行无 `。！？` + 长度 ≤ 24（排除「以：结尾的长句」误判，如草稿段里向学生提问的长句含 `。` 被剔除）。已用 DB id=80 真实样本验证：流式逐行增长模拟，折叠态正好切换 4 次停在 4 个真标题，无内容泄漏。
- **content 中的结构化 JSON 块**：流式中可能短暂可见，`done` 时由 responseParser strip（现有逻辑）。
- 保留非流式 `/ai/tutor` 端点不动（兜底）。

## 文件
- 后端：`ai-core/types.ts`（+StreamEvent）、`ai-core/capabilities/tutoring.capability.ts`（+prepare/+tutorStream，重构 tutor）、`modules/ai/ai.service.ts`（+tutorStream）、`modules/ai/ai.controller.ts`（+stream endpoint）。
- 前端：`store/chatStore.ts`（+appendToLastAssistant）、`hooks/useAuxChat.ts`（流式 fetch，删 WS）、`components/business/AuxChatPanel.tsx`（reasoning 流式 UI）。

## 验证
- tsc 两端通过；后端 vitest 106/106 不回归。
- 实调 `/api/ai/tutor/stream`：确认 SSE 事件序 = reasoning 增量... → content 增量... → done。
- 前端：发消息 → 思考框实时滚动最后一行 → 可展开看完整思考 → content 逐字出现 → done 后 JSON 被 strip、折叠框回到预览。
