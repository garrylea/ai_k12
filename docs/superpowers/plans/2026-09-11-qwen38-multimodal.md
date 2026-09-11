# qwen3.8-max 改名 + 多模态替代 VL / 去两阶段图片流程 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `qwen3.7-max` 全局换成 `qwen3.8-max`，用它的多模态能力取代两个 VL 模型与图片两阶段流程（图片+文本直送主模型），并让判题调用不带 thinking。

**Architecture:** 配置层改名并删 `transcribe` 场景/两个 VL 模型；`ChatRequest` 加请求级 `thinking` 开关（仅 `JudgmentCapability` 传 `false`），避免为单开关加 DB 列；后端删 `TutoringCapability` 的 VL 原语与 `AIService` 的 flow 状态机（`idle+图片` 直接走辅导，图片作为 `image_url` 部件随消息送出）；前端删确认/选择 UI；DB 靠幂等迁移脚本落地（先插新模型 → 改路由 → 删 transcribe 路由 → 删旧模型，受 primary FK 约束）。

**Tech Stack:** Node.js + TypeScript ESM、NestJS、Vitest、Zod、js-yaml、mysql2、React + Zustand。

**Spec:** `docs/superpowers/specs/2026-09-11-qwen38-multimodal-design.md`

## Global Constraints

- 命令默认在 `apps/server/` 下运行；前端命令在 `apps/web/`。
- TS 严格模式、2 空格缩进；ESM 相对导入必须带 `.js` 后缀；类 PascalCase、函数/变量 camelCase。
- 配置后置名（勿写成别的）：`qwen3.8-max`（key 与 modelId 同名）、`local`（判题主模型，已存在）。
- `thinking` 语义：`ChatRequest.thinking?: boolean`；`buildRequestBody` 下发 `enable_thinking = request.thinking !== false`（不传 = true，其它场景行为不变）。
- `judgment` 路由：`primary: local`、`fallback: qwen3.8-max`（不要再出现 `deepseek-v4-flash` 作为判题 fallback）。
- **必须保留**：`hasImage`（safety-guard 在用）、`SaveMessageEntry.type='transcription'`（训练「讲一讲」题面锚消息，与图片流程无关）、DB 列 `flow_state`/`pending_question`/`pending_questions`（保留为死数据，不做列迁移）。
- **必须同一步完成**：`Scene`/`CapabilityType` 去 `'transcribe'` + `prompt-builder` 去 transcribe 分支 + 删 `prompts/transcribe/math.md`，否则 `resolveTemplatePath` 对未知 capability 抛错。
- 每个任务结束必须 `npm test`（当前 418）与 `npm run build` 全绿后再 commit；前端任务需 `npm run build && npm run lint` 通过。
- 无 emoji；Conventional Commits（scope：`ai-core`、`server`、`web`、`docs`）。

---

## File Structure

| 文件 | 职责 / 本次改动 |
|---|---|
| `src/ai-core/types.ts` | 类型契约：加 `ChatRequest.thinking`；删 transcribe/flow 类型与联合成员 |
| `src/ai-core/infra/model-client/openai-compatible-client.ts` | 请求体：`enable_thinking` 改为可配 |
| `src/ai-core/capabilities/judgment.capability.ts` | 判题两次调用都传 `thinking:false` |
| `src/ai-core/capabilities/tutoring.capability.ts` | 删 VL 原语（transcribeImage/classifySelection/parseTranscribeResult/parseSelectionResult） |
| `src/ai-core/model-routes.yaml` | 改名 + 删 VL/transcribe 路由 + judgment fallback |
| `src/ai-core/retry.yaml` | 删 `transcribe` 超时 |
| `src/ai-core/infra/prompt-builder.ts` | 删 transcribe 分支 |
| `src/ai-core/prompts/transcribe/math.md` | 删除 |
| `src/modules/ai/ai.service.ts` | 删 flow 状态机三段 + 分支 + flowAction |
| `src/modules/ai/dto/tutor.dto.ts` | 删 `flowAction` |
| `src/services/conversation/index.ts` | 删 `updateFlowState` + load 的 flow 字段 |
| `src/database/repositories/ai-dialogues.repo.ts` | 删 `updateFlowState` |
| `src/modules/admin/admin-models.service.ts` | `SCENES` 去 `transcribe` |
| `src/scripts/migrate-qwen38-multimodal.ts` | **新增**：幂等 DB 迁移 |
| `apps/web/src/store/chatStore.ts` | 删 flow 状态 |
| `apps/web/src/hooks/useAuxChat.ts` | 删 flowAction/flow 事件/确认按钮逻辑 |
| `apps/web/src/components/business/AuxChatPanel.tsx` | 删确认/选择 UI |
| `apps/web/src/pages/student/AuxiliaryHomePage.tsx` | 删按钮接线 |
| `tools/deploy/apply-llm-config.mjs`、`tools/deploy.sh` | qwen 默认模型改名 |
| `CLAUDE.md`、`docs/ai-core-changelog.md`、`docs/K12智学系统-AI-Agent中枢设计文档.md`、`docs/K12智学系统-数据库设计文档.md` | 文档同步 |

---

### Task 1: 请求级 thinking 开关（仅判题关）

**Files:**
- Modify: `src/ai-core/types.ts`（`ChatRequest`）
- Modify: `src/ai-core/infra/model-client/openai-compatible-client.ts`
- Modify: `src/ai-core/capabilities/judgment.capability.ts`
- Test: `src/ai-core/infra/model-client/openai-compatible-client.test.ts`、`src/ai-core/capabilities/judgment.capability.test.ts`

**Interfaces:**
- Produces: `ChatRequest.thinking?: boolean`（`false` = 下发 `enable_thinking:false`；`undefined`/`true` = 下发 `true`）。
- 后续任务不依赖本任务产出（独立）。

- [ ] **Step 1: 写失败测试**

在 `openai-compatible-client.test.ts` 的 `describe` 内追加：

```ts
  it('thinking:false 时下发 enable_thinking:false', () => {
    const body = (new OpenAICompatibleClient('sk-x') as any).buildRequestBody({ ...request, thinking: false }, false);
    expect(body.enable_thinking).toBe(false);
  });

  it('不传 thinking 时仍下发 enable_thinking:true（默认行为不变）', () => {
    const body = (new OpenAICompatibleClient('sk-x') as any).buildRequestBody(request, false);
    expect(body.enable_thinking).toBe(true);
  });
```

在 `judgment.capability.test.ts` 的「primary 成功时不调用 fallback」用例内追加一行：

```ts
    expect(mockChat.mock.calls[0][0].thinking).toBe(false);
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/ai-core/infra/model-client/openai-compatible-client.test.ts src/ai-core/capabilities/judgment.capability.test.ts`
Expected: FAIL —— `enable_thinking` 恒为 `true`（新用例断言 `false` 失败）；judgment 用例 `thinking` 为 `undefined`。

- [ ] **Step 3: 类型加 `thinking`**

`src/ai-core/types.ts` 的 `ChatRequest`（约 122–133 行）在 `stream?: boolean;` 之后加：

```ts
  /** 是否启用模型 thinking；false 时请求体下发 enable_thinking:false（默认 true）。 */
  thinking?: boolean;
```

- [ ] **Step 4: 请求体改为可配**

`src/ai-core/infra/model-client/openai-compatible-client.ts` 的 `buildRequestBody` 内，把 `body.enable_thinking = true;` 改为：

```ts
    body.enable_thinking = request.thinking !== false;
```

- [ ] **Step 5: 判题两次调用都关 thinking**

`src/ai-core/capabilities/judgment.capability.ts` 的 `callModel` 内，`modelClient.chat({...})` 加一行（放在 `responseFormat` 之后）：

```ts
      thinking: false,
```

- [ ] **Step 6: 运行确认通过**

Run: `npx vitest run src/ai-core/infra/model-client/openai-compatible-client.test.ts src/ai-core/capabilities/judgment.capability.test.ts`
Expected: PASS。

- [ ] **Step 7: 全量测试 + 构建**

Run: `npm test && npm run build`
Expected: 全部通过（420 tests 左右）、tsc 无错误。

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/ai-core/types.ts \
        apps/server/src/ai-core/infra/model-client/openai-compatible-client.ts \
        apps/server/src/ai-core/infra/model-client/openai-compatible-client.test.ts \
        apps/server/src/ai-core/capabilities/judgment.capability.ts \
        apps/server/src/ai-core/capabilities/judgment.capability.test.ts
git commit -m "feat(ai-core): per-request thinking flag; judgment runs without thinking"
```

---

### Task 2: YAML 改名 + 删 VL/transcribe 路由

**Files:**
- Modify: `src/ai-core/model-routes.yaml`
- Modify: `src/ai-core/retry.yaml`
- Test: `src/ai-core/infra/model-router.test.ts`（整体替换）、`src/ai-core/infra/model-router-dynamic.test.ts`

**Interfaces:**
- Consumes: Task 1 无依赖。
- Produces: 模型 key `qwen3.8-max`（modelId 同名）；`judgment` 路由 `primary: local / fallback: qwen3.8-max`；不再有 `transcribe` 场景路由与 VL 模型条目。后续 Task 3/5/6 依赖这些名字。

- [ ] **Step 1: 更新路由测试断言（先失败）**

整体替换 `src/ai-core/infra/model-router.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { ModelRouter } from './model-router.js';

describe('ModelRouter', () => {
  const router = new ModelRouter();

  it('routes math tutoring (easy) to qwen3.8-max primary with deepseek fallback', () => {
    const result = router.route({ scene: 'tutoring', subject: 'math', difficulty: 1 });
    expect(result.primary.modelId).toBe('qwen3.8-max');
    expect(result.fallback?.modelId).toBe('deepseek-v4-flash');
  });

  it('routes math tutoring (hard) to gemini-3.1-pro primary with qwen fallback', () => {
    const result = router.route({ scene: 'tutoring', subject: 'math', difficulty: 3 });
    expect(result.primary.modelId).toBe('gemini-3.1-pro');
    expect(result.fallback?.modelId).toBe('qwen3.8-max');
  });

  it('routes safety scene to deepseek-v4-flash with no fallback', () => {
    const result = router.route({ scene: 'safety', subject: 'math' });
    expect(result.primary.modelId).toBe('deepseek-v4-flash');
    expect(result.fallback).toBeUndefined();
  });

  it('routes structuring scene to deepseek-v4-flash', () => {
    const result = router.route({ scene: 'structuring', subject: 'math' });
    expect(result.primary.modelId).toBe('deepseek-v4-flash');
  });

  it('routes chinese tutoring to kimi primary', () => {
    const result = router.route({ scene: 'tutoring', subject: 'chinese' });
    expect(result.primary.modelId).toBe('kimi-latest');
  });

  it('falls back to default when scene not in route table', () => {
    const result = router.route({ scene: 'analysis', subject: 'math' });
    expect(result.primary.modelId).toBe('kimi-latest');
    expect(result.fallback?.modelId).toBe('qwen3.8-max');
  });

  it('matches without difficulty (loose match)', () => {
    const result = router.route({ scene: 'grading', subject: 'math' });
    expect(result.primary.modelId).toBe('deepseek-v4-flash');
    expect(result.fallback?.modelId).toBe('qwen3.8-max');
  });

  it('routes math judgment to local primary with qwen3.8-max fallback', () => {
    // 训练模块判题默认走本地 llama.cpp；本地不可用回退 qwen3.8-max（无 thinking，见 JudgmentCapability）
    const result = router.route({ scene: 'judgment', subject: 'math' });
    expect(result.primary.modelId).toBe('Qwen3.8-27B');
    expect(result.primary.provider).toBe('local');
    expect(result.fallback?.modelId).toBe('qwen3.8-max');
  });

  it('tutoring ignores hasImage and uses the text model (image is sent directly)', () => {
    const result = router.route({ scene: 'tutoring', subject: 'math', hasImage: true });
    expect(result.primary.modelId).toBe('qwen3.8-max');
  });

  it('does not route to a VL model for non-tutoring scenes even with image', () => {
    const result = router.route({ scene: 'grading', subject: 'math', hasImage: true });
    expect(result.primary.modelId).toBe('deepseek-v4-flash');
  });
});
```

`src/ai-core/infra/model-router-dynamic.test.ts`：把两处 `'qwen3.7-max'` 改为 `'qwen3.8-max'`（第 8、15 行）。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/ai-core/infra/model-router.test.ts src/ai-core/infra/model-router-dynamic.test.ts`
Expected: FAIL（仍返回 `qwen3.7-max` / `qwen-vl-max` / judgment fallback `deepseek-v4-flash`）。

- [ ] **Step 3: 改 YAML 模型定义**

`src/ai-core/model-routes.yaml`：把 `qwen3.7-max:` 块（15–25 行）整体替换为：

```yaml
  qwen3.8-max:
    provider: qwen
    modelId: qwen3.8-max
    baseUrl: ${QWEN_BASE_URL}
    apiKey: ${QWEN_API_KEY}
    contextWindow: 131072
    maxOutputTokens: 32768
    costPer1K:
      input: 0.007
      output: 0.028
    supportsStreaming: true
```

删除 `qwen-vl-max:`（65–77）与 `qwen3-vl-plus:`（79–91）两个块（含其上注释）。

- [ ] **Step 4: 改 YAML 路由**

- 全文把路由里的 `qwen3.7-max` 改为 `qwen3.8-max`（tutoring、grading、explanation、hint、variation、analysis、structuring，以及 `grading` 注释 119 行、`default.primary` 174 行）。
- 删除 `transcribe:` 路由块（95–100，含其上注释）。
- `judgment:` 路由改为：

```yaml
  judgment:
    - subject: math
      # 训练模块（专项/考试/错题）判题默认走本地 Qwen3.8-27B；
      # 本地不可用回退 qwen3.8-max（JudgmentCapability 传 thinking:false）。
      primary: local
      fallback: qwen3.8-max
```

- `src/ai-core/retry.yaml`：删除 `transcribe: 60000` 行（含行内注释）。

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run src/ai-core/infra/model-router.test.ts src/ai-core/infra/model-router-dynamic.test.ts`
Expected: PASS。

- [ ] **Step 6: 全量测试 + 构建**

Run: `npm test && npm run build`
Expected: 全部通过；tsc 无错误（此时 `transcribe` 代码仍在，仅配置与路由测试变了——若 `npm test` 因 Vitest 收集报错，说明还有测试引用旧断言，逐一改到 qwen3.8-max）。

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/ai-core/model-routes.yaml \
        apps/server/src/ai-core/retry.yaml \
        apps/server/src/ai-core/infra/model-router.test.ts \
        apps/server/src/ai-core/infra/model-router-dynamic.test.ts
git commit -m "feat(ai-core): rename qwen3.7-max to qwen3.8-max; drop VL models and transcribe route"
```

---

### Task 3: 后端删除两阶段图片流程（一体化）

**Files:**
- Modify: `src/ai-core/capabilities/tutoring.capability.ts`
- Modify: `src/ai-core/infra/prompt-builder.ts`
- Delete: `src/ai-core/prompts/transcribe/math.md`
- Modify: `src/ai-core/types.ts`
- Modify: `src/modules/ai/ai.service.ts`
- Modify: `src/modules/ai/dto/tutor.dto.ts`
- Modify: `src/services/conversation/index.ts`
- Modify: `src/database/repositories/ai-dialogues.repo.ts`
- Modify: `src/modules/admin/admin-models.service.ts`
- Test: `src/ai-core/capabilities/tutoring.capability.test.ts`

**Interfaces:**
- Consumes: Task 2（配置层已无 `transcribe`）。
- Produces: 图片走 `tutoring.tutorStream()`，图片以 `image_url` 部件随最后一条 user 消息送出；不再有 `transcribeImage`/`classifySelection`/`updateFlowState`/`flowAction`。

> **本任务必须一次完成**：删除的类型被 `ai.service.ts` 引用，分两步会让 tsc 失败。按步骤顺序做，最后统一跑测试。

- [ ] **Step 1: 删 `TutoringCapability` 的 VL 原语**

`src/ai-core/capabilities/tutoring.capability.ts`：

1. 删除方法 `transcribeImage`（208–233）、`classifySelection`（237–256）、`parseTranscribeResult`（280–295）、`parseSelectionResult`（从 `private parseSelectionResult(` 到该方法闭合 `}`）。保留 `augmentWithImages`（258–278）。不要删除 `extractJsonObject`（结构化题目解析仍在用）。
2. 把 `augmentWithImages` 上的注释改为：

```ts
  /** Replace the last user message's content with a multimodal array (text +
   *  image_url parts) so the tutoring model receives images directly. */
```

3. 文件首行 import 中删除 `TranscribeResult, TranscribedProblem`；删除 `SelectionClassification`（若在同一 import 列表）。保留 `ContentPart, ChatMessage, Subject, TextPart, Attachment` 等仍在用的。

- [ ] **Step 2: 删 prompt-builder 的 transcribe 分支**

`src/ai-core/infra/prompt-builder.ts`：删除

```ts
    if (capability === 'transcribe') {
      return `transcribe/${subject}.md`;
    }
```

并删除 `apps/server/src/ai-core/prompts/transcribe/math.md`（连同空目录）。

- [ ] **Step 3: 删 types.ts 的 transcribe / flow 契约**

`src/ai-core/types.ts`：

1. `Scene`（15）：去掉 `| 'transcribe'`；`CapabilityType`（51）：去掉 `| 'transcribe'`。
2. 删除 `TranscribedProblem` 与 `TranscribeResult`（170–180 附近，连同注释）。
3. 若 `SelectionClassification`（约 182–186）除 `classifySelection` 外无引用，一并删除。
4. `StreamEvent`：把 `type` 联合（156）去掉 `'flow'`，并删除 flow 字段（`stage?` / `problems?` / `question?` 三行及其注释）。
5. 删除 `TutoringRequest.flowAction`（411 及其注释）。
6. `LoadContextResponse`（577–579）：删除 `flowState` / `pendingQuestion` / `pendingQuestions` 三个字段。
7. `RouteRequest.hasImage`（27）注释改为：

```ts
  hasImage?: boolean;  // 仅供 SafetyGuard 放宽 off_topic 判定；路由不再据此切模型
  // （图片直接作为 image_url 部件送给辅导模型）
```

- [ ] **Step 4: 删 `AIService` 的 flow 状态机**

`src/modules/ai/ai.service.ts`：

1. 顶部 import 去掉 `TranscribedProblem`（10）与不再使用的 `Attachment`（若仅 `transcribeStage` 用）。
2. 删除 `transcribeStage`（120–156）、`selectionStage`（158–186）、`correctStage`（188–198）三个方法。
3. `handleStream`（81–118）里删除 `const hasImage = ...`（89）与 `if (context.flowState === ...)` 整组分支（92–111），只保留：

```ts
    try {
      yield* this.tutorStage(dto, userId, request, signal);
    } catch (err) {
```

   并把 `handleStream` 上方的 docblock（69–80）改为：

```ts
  /**
   * Streaming tutor. `idle + image` and `idle + text` both go straight to the
   * Socratic tutoring path; images are attached to the user message as
   * `image_url` parts by the capability (no transcription stage).
   * Pre-stream errors throw HttpException; mid-stream model errors are yielded
   * as `{type:'error'}` by the capability.
   */
```

4. `tutorStage`（200–215）：删除 `await this.conversationService.updateFlowState(dialogueId, 'idle', null, null).catch(() => {});` 这一行（213）及其注释（212）。
5. `validateDto`（219–232）：把守卫改为

```ts
  private validateDto(dto: TutorDto) {
    // 图片-only 发送允许空 message；其余必须有 message。
    const hasMessage = !!dto.message && dto.message.trim().length > 0;
    if (!hasMessage && !dto.attachments?.length) {
      throw new BadRequestException({ code: 1001, message: 'message 不能为空' });
    }
```

   并删除原 `P1: message may be empty ... flow action` 注释。
6. `buildRequest`（384）：删除 `...(dto.flowAction ? { flowAction: dto.flowAction } : {}),`。
7. 删除分支后 `const context = await this.conversationService.loadContext(dialogueId);` 与其 `if (!context) throw ...`（87–88）会变成未使用——一并删除（对话存在性已由 `resolveDialogue` → `conversationsService.get` 校验）。若 `hasImage`/`Attachment`/`TutoringRequest` 等 import 随之不再使用，按 tsc 报错删除。

- [ ] **Step 5: 删 DTO / conversation / repo 的 flow**

1. `src/modules/ai/dto/tutor.dto.ts`：删除 `flowAction?: 'confirm' | 'reidentify' | 'correct';`（17 及其注释）。
2. `src/services/conversation/index.ts`：
   - 删除 load 返回中的 `flowState` / `pendingQuestion` / `pendingQuestions`（114–116）；
   - 删除 `updateFlowState` 方法（162–172，含注释）。
3. `src/database/repositories/ai-dialogues.repo.ts`：删除 `updateFlowState` 方法（129–141，含注释）。
4. **保留** `src/database/repositories/types.ts` 的 `flow_state` 字段（忠实镜像 DB 列，删除反而要改 `mapRow`）。
5. `src/modules/admin/admin-models.service.ts`：`SCENES`（8）去掉 `'transcribe'`。

- [ ] **Step 6: 更新 tutoring 测试**

`src/ai-core/capabilities/tutoring.capability.test.ts`：删除所有引用 `transcribeImage`/`classifySelection`/transcribe 场景/flow 的用例；保留并把「图片以 `image_url` 部件送达辅导模型」用例中的 mock 模型名从 `qwen-vl-max` 改为 `qwen3.8-max`（约 211 行），断言不变（断言消息里出现 `image_url` 部件）。把 176–178 的注释改为「图片直接作为 image_url 部件送入辅导模型（不再两阶段）」。

- [ ] **Step 7: 全量测试 + 构建**

Run: `npm test && npm run build`
Expected: 全部通过；tsc 无错误。若 tsc 报「未使用 import」，按报错删除。

- [ ] **Step 8: Commit**

```bash
git add -A apps/server/src/ai-core apps/server/src/modules apps/server/src/services apps/server/src/database
git commit -m "refactor(ai-core): drop image two-stage flow; send images straight to the multimodal tutor"
```

---

### Task 4: 前端删除 flow 交互

**Files:**
- Modify: `apps/web/src/store/chatStore.ts`（整体替换）
- Modify: `apps/web/src/hooks/useAuxChat.ts`
- Modify: `apps/web/src/components/business/AuxChatPanel.tsx`
- Modify: `apps/web/src/pages/student/AuxiliaryHomePage.tsx`

**Interfaces:**
- Consumes: Task 3（后端不再发 flow 事件）。
- Produces: 前端不再有 `ChatFlow`/`flowAction`/确认按钮；图片直接发送。

- [ ] **Step 1: 替换 chatStore**

整体替换 `apps/web/src/store/chatStore.ts`：

```ts
import { create } from 'zustand';

export interface ChatError {
  code: number;
  message: string;
  retryable: boolean;
  stage?: 'tutor';  // which stage failed
}

export interface ChatMessage {
  id?: number;
  role: 'user' | 'assistant';
  content: string;
  type?: string;
  images?: string[];
  reasoning?: string;
  streaming?: boolean;
  error?: ChatError;
}

interface ChatState {
  messages: ChatMessage[];
  isStreaming: boolean;
  setMessages: (msgs: ChatMessage[]) => void;
  appendMessage: (msg: ChatMessage) => void;
  removeMessage: (messageId: number) => void;
  updateLastAssistant: (content: string, reasoning?: string) => void;
  appendLastAssistant: (opts: { content?: string; reasoning?: string }) => void;
  setLastAssistantError: (err: ChatError) => void;
  resetLastAssistantToStreaming: () => void;
  setIsStreaming: (v: boolean) => void;
  reset: () => void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  isStreaming: false,
  setMessages: (msgs) => set({ messages: msgs }),
  appendMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  removeMessage: (messageId) =>
    set((s) => ({ messages: s.messages.filter((m) => m.id !== messageId) })),
  updateLastAssistant: (content, reasoning) =>
    set((s) => {
      const messages = [...s.messages];
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant') {
        messages[messages.length - 1] = {
          ...last,
          content,
          ...(reasoning !== undefined ? { reasoning } : {}),
        };
      }
      return { messages };
    }),
  appendLastAssistant: (opts) =>
    set((s) => {
      const messages = [...s.messages];
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant') {
        const updated: ChatMessage = { ...last };
        if (opts.content !== undefined) updated.content = last.content + opts.content;
        if (opts.reasoning !== undefined) updated.reasoning = (last.reasoning ?? '') + opts.reasoning;
        messages[messages.length - 1] = updated;
      }
      return { messages };
    }),
  setLastAssistantError: (err) =>
    set((s) => {
      const messages = [...s.messages];
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant') {
        messages[messages.length - 1] = {
          ...last,
          content: '',
          reasoning: last.reasoning,
          streaming: false,
          error: err,
        };
      }
      return { messages, isStreaming: false };
    }),
  resetLastAssistantToStreaming: () =>
    set((s) => {
      const messages = [...s.messages];
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant') {
        messages[messages.length - 1] = { role: 'assistant', content: '', streaming: true };
      } else {
        messages.push({ role: 'assistant', content: '', streaming: true });
      }
      return { messages, isStreaming: true };
    }),
  setIsStreaming: (v) => set({ isStreaming: v }),
  reset: () => set({ messages: [], isStreaming: false }),
}));
```

- [ ] **Step 2: 改 useAuxChat**

`apps/web/src/hooks/useAuxChat.ts`：

1. 本地 `StreamEvent`（19–30）：`type` 联合去掉 `'flow'`，删除 `stage?`/`question?`/`problems?` 三个字段与 P1 注释。
2. 从 `useChatStore()` 解构（51–61）去掉 `setLastAssistantFlow`。
3. `streamTutor` 签名（105）：去掉 `flowAction?: 'confirm' | 'reidentify' | 'correct'` 参数；请求体（116–123）删除 `...(flowAction ? { flowAction } : {})`；删除整个 `else if (event.type === 'flow') { ... }` 分支（161–172）；依赖数组（185）去掉 `setLastAssistantFlow`。
4. `send`（250–304）：签名去掉 `explicitFlowAction`；删除 `inConfirm`/`flowAction` 三行（254–257）与守卫里的 `&& !flowAction`；`apiMessage`（278）改为 `const apiMessage = content.trim() || '帮我看一下这道题';`；`userDisplay`（281–284）改为 `const userDisplay = content.trim();`；`streamTutor` 调用（290）去掉最后一个参数。
5. 删除 `confirmQuestion` / `reidentify`（306–308）。
6. 返回值（347）改为 `return { send, stop, retry, isLoadingHistory, deleteMsg };`

- [ ] **Step 3: 改 AuxChatPanel**

`apps/web/src/components/business/AuxChatPanel.tsx`：

1. Props 去掉 `onConfirm?: () => void;` 与 `onReidentify?: () => void;`（13–14，含注释）。
2. 删除整个 flow UI 块（366–393：`{m.flow && !isError && !isStreaming && ( ... )}`）。

- [ ] **Step 4: 改 AuxiliaryHomePage**

`apps/web/src/pages/student/AuxiliaryHomePage.tsx`：从 `useAuxChat(...)` 解构（42）去掉 `confirmQuestion, reidentify`；删除传给 `AuxChatPanel` 的 `onConfirm`/`onReidentify`（98 附近）。

- [ ] **Step 5: 构建 + lint**

Run: `npm run build && npm run lint`（apps/web）
Expected: tsc + vite build 通过；lint 无新增错误。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/store/chatStore.ts \
        apps/web/src/hooks/useAuxChat.ts \
        apps/web/src/components/business/AuxChatPanel.tsx \
        apps/web/src/pages/student/AuxiliaryHomePage.tsx
git commit -m "refactor(web): remove image two-stage confirm/select UI"
```

---

### Task 5: DB 迁移脚本 + 部署脚本

**Files:**
- Create: `src/scripts/migrate-qwen38-multimodal.ts`
- Modify: `tools/deploy/apply-llm-config.mjs`
- Modify: `tools/deploy.sh`

**Interfaces:**
- Consumes: Task 2（YAML 已有 `qwen3.8-max` 模型与 judgment 路由；已无 VL/transcribe）。
- Produces: 幂等脚本，把已 seed 的库切到新配置。

- [ ] **Step 1: 创建迁移脚本**

创建 `apps/server/src/scripts/migrate-qwen38-multimodal.ts`：

```ts
/**
 * 把已 seed 的库迁到 qwen3.8-max + 去 VL/两阶段配置：
 *   1) upsert qwen3.8-max 模型行（必须先于路由改名：primary FK 指向 llm_models.model_key）
 *   2) 路由 qwen3.7-max -> qwen3.8-max（primary + fallback）
 *   3) judgment/math 路由设为 local / qwen3.8-max
 *   4) 删 transcribe 路由
 *   5) 删旧模型行 qwen3.7-max / qwen3-vl-plus / qwen-vl-max（在 1-4 之后，确保无 primary 引用）
 *   6) 重置 ai_dialogues 遗留 flow 状态（best-effort，列结构不动）
 *
 * 运行：cd apps/server && npx tsx src/scripts/migrate-qwen38-multimodal.ts
 * 生效：重启后端，或在后台保存一次路由触发 registry.reload()。幂等，可重复运行。
 */
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import mysql from 'mysql2/promise';
import { routeConfig } from '../ai-core/config.js';
import { encryptApiKey } from '../common/utils/api-key-crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../.env') });

const OLD_QWEN = 'qwen3.7-max';
const NEW_QWEN = 'qwen3.8-max';
const DROP_MODELS = [OLD_QWEN, 'qwen3-vl-plus', 'qwen-vl-max'];

async function main() {
  const model = routeConfig.models[NEW_QWEN];
  const judgment = routeConfig.routes.judgment?.find((r) => r.subject === 'math');
  if (!model) throw new Error(`YAML 缺少 models.${NEW_QWEN}`);
  if (!judgment) throw new Error('YAML 缺少 routes.judgment（subject=math）');
  if (!model.baseUrl) throw new Error('QWEN_BASE_URL 未配置（检查 apps/server/.env）');
  if (!model.apiKey) throw new Error('QWEN_API_KEY 未配置（检查 apps/server/.env）');

  const pool = mysql.createPool({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'ai_k12',
    password: process.env.DB_PASS ?? 'ai_k12',
    database: process.env.DB_NAME ?? 'ai_k12',
  });

  // 1) upsert 新模型
  const [mRows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT id FROM llm_models WHERE model_key = ?', [NEW_QWEN]);
  const encryptedKey = encryptApiKey(model.apiKey);
  if (mRows.length > 0) {
    await pool.execute(
      `UPDATE llm_models SET name=?, provider_type=?, model_id=?, base_url=?, api_key=?,
         context_window=?, max_output_tokens=?, is_enabled=1, updated_at=CURRENT_TIMESTAMP(3)
       WHERE model_key=?`,
      [NEW_QWEN, model.provider, model.modelId, model.baseUrl, encryptedKey,
       model.contextWindow, model.maxOutputTokens, NEW_QWEN]);
    console.log(`[migrate-qwen38] 模型 ${NEW_QWEN} 已更新`);
  } else {
    await pool.execute(
      `INSERT INTO llm_models
         (model_key, name, provider_type, model_id, base_url, api_key, context_window, max_output_tokens, is_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [NEW_QWEN, NEW_QWEN, model.provider, model.modelId, model.baseUrl, encryptedKey,
       model.contextWindow, model.maxOutputTokens]);
    console.log(`[migrate-qwen38] 模型 ${NEW_QWEN} 已插入`);
  }

  // 2) 路由改名
  const [p] = await pool.execute(
    'UPDATE llm_routes SET primary_model_key=?, updated_at=CURRENT_TIMESTAMP(3) WHERE primary_model_key=?',
    [NEW_QWEN, OLD_QWEN]);
  const [f] = await pool.execute(
    'UPDATE llm_routes SET fallback_model_key=?, updated_at=CURRENT_TIMESTAMP(3) WHERE fallback_model_key=?',
    [NEW_QWEN, OLD_QWEN]);
  console.log(`[migrate-qwen38] 路由改名：primary ${(p as mysql.ResultSetHeader).affectedRows} 行 / fallback ${(f as mysql.ResultSetHeader).affectedRows} 行`);

  // 3) 判题路由
  const [j] = await pool.execute(
    `UPDATE llm_routes SET primary_model_key=?, fallback_model_key=?, updated_at=CURRENT_TIMESTAMP(3)
     WHERE scene='judgment' AND subject='math'`,
    [judgment.primary, judgment.fallback ?? null]);
  console.log(`[migrate-qwen38] 判题路由：${(j as mysql.ResultSetHeader).affectedRows} 行 -> ${judgment.primary} / ${judgment.fallback ?? '-'}`);

  // 4) 删 transcribe 路由
  const [t] = await pool.execute("DELETE FROM llm_routes WHERE scene='transcribe'");
  console.log(`[migrate-qwen38] 删除 transcribe 路由：${(t as mysql.ResultSetHeader).affectedRows} 行`);

  // 5) 删旧模型行
  const [d] = await pool.execute(
    `DELETE FROM llm_models WHERE model_key IN (?, ?, ?)`, DROP_MODELS);
  console.log(`[migrate-qwen38] 删除旧模型行：${(d as mysql.ResultSetHeader).affectedRows} 行（${DROP_MODELS.join(', ')}）`);

  // 6) 重置遗留 flow 状态
  const [r] = await pool.execute(
    `UPDATE ai_dialogues SET flow_state='idle', pending_question=NULL, pending_questions=NULL
     WHERE flow_state IS NOT NULL AND flow_state <> 'idle'`);
  console.log(`[migrate-qwen38] 重置遗留 flow 状态：${(r as mysql.ResultSetHeader).affectedRows} 行`);

  console.log('[migrate-qwen38] 完成。重启后端（或后台保存路由）后生效。');
  await pool.end();
}

main().catch((e) => { console.error('[migrate-qwen38] 失败:', e); process.exit(1); });
```

- [ ] **Step 2: 构建 + 运行 + 校验**

Run: `npm run build`
Expected: tsc 无错误。

Run: `npx tsx src/scripts/migrate-qwen38-multimodal.ts`
Expected: 打印各步骤行数，最后「完成」。

Run:
```bash
mysql -uai_k12 -pai_k12 ai_k12 -e "SELECT model_key FROM llm_models ORDER BY model_key; SELECT scene, subject, primary_model_key, fallback_model_key FROM llm_routes WHERE scene IN ('judgment','transcribe');"
```
Expected: 模型表含 `qwen3.8-max`，不含 `qwen3.7-max` / `qwen3-vl-plus` / `qwen-vl-max`；路由只有 `judgment | math | local | qwen3.8-max`，无 `transcribe`。

- [ ] **Step 3: 幂等复验**

Run: `npx tsx src/scripts/migrate-qwen38-multimodal.ts`（再跑一次）
Expected: 各步 0 或「已更新」，无重复行，Step 2 的查询结果不变。

- [ ] **Step 4: 部署脚本改名**

- `tools/deploy/apply-llm-config.mjs:22`：`qwen: 'qwen3.7-max',` → `qwen: 'qwen3.8-max',`
- `tools/deploy.sh:315`：`def_model='qwen3.7-max'` → `def_model='qwen3.8-max'`
- 检查 `apply-llm-config.mjs` 顶部注释里的模型示例（第 10 行）一并改为 `qwen3.8-max`。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/scripts/migrate-qwen38-multimodal.ts tools/deploy/apply-llm-config.mjs tools/deploy.sh
git commit -m "feat(server): idempotent migration to qwen3.8-max and VL removal"
```

---

### Task 6: 文档同步

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/ai-core-changelog.md`
- Modify: `docs/K12智学系统-AI-Agent中枢设计文档.md`
- Modify: `docs/K12智学系统-数据库设计文档.md`

**Interfaces:**
- Consumes: Tasks 1–5 的实际实现与脚本名。
- Produces: 无代码接口。

- [ ] **Step 1: 更新 CLAUDE.md**

- 「模型 ID（勿改）」（约 174 行）：`qwen3.7-max` → `qwen3.8-max`；并补 `Qwen3.8-27B`（本地 llama.cpp，`local` provider）。
- 「场景路由（勿随意切换）」（约 178 行）：`qwen3.7-max` → `qwen3.8-max`；删去「图片转录走独立 `transcribe` 场景（`qwen3-vl-plus`，fallback qwen-vl-max），辅导不因带图切换模型」，改为「图片直接作为 `image_url` 部件随消息送给辅导模型（`qwen3.8-max` 多模态），无转录/确认两阶段」；judgment 段补「判题调用不带 thinking（`ChatRequest.thinking=false`）」。
- 在 ai-core 关键约定处补一条：`qwen3.8-max` 支持多模态；两阶段图片流程与 VL 模型已删除（`qwen-vl-max`/`qwen3-vl-plus` 不再存在）；`ai_dialogues.flow_state/pending_question(s)` 为遗留死数据。

- [ ] **Step 2: 追加 changelog 条目**

在 `docs/ai-core-changelog.md` 的 intro `---` 之后、`## 2026-09-11 训练模块判题默认走本地模型` 之前插入：

```markdown
## 2026-09-11 qwen3.8-max 改名 + 多模态替代 VL / 去掉两阶段图片流程

- **变更摘要**：`qwen3.7-max` 全局改名 `qwen3.8-max`（YAML 模型定义/所有路由/`default`/DB/deploy 脚本）。因 `qwen3.8-max` 支持多模态（实测 OpenAI 兼容模式 `image_url` 可用），删除 `qwen-vl-max`/`qwen3-vl-plus` 两个模型与 `transcribe` 场景，图片+文本直接送给辅导模型（`TutoringCapability.augmentWithImages` 把最后一条 user 消息改为 text+image_url 部件）。删除图片两阶段流程：`TutoringCapability` 的 `transcribeImage`/`classifySelection`/`parseTranscribeResult`/`parseSelectionResult`、`AIService` 的 `transcribeStage`/`selectionStage`/`correctStage` 与 flow 分支、`TutorDto.flowAction`、`ConversationService.updateFlowState`、前端 `chatStore` 的 `ChatFlow`/`ChatMessage.flow`、`useAuxChat` 的 flowAction/flow 事件、`AuxChatPanel` 的「确认/重新识别」UI；一图多题交给 `prompts/tutoring/math/auxiliary.md` 已有的图片/多题处理段。新增请求级 thinking 开关（`ChatRequest.thinking?: boolean`，`buildRequestBody` 下发 `enable_thinking = thinking !== false`），`JudgmentCapability` 判题两次调用都传 `false`（不建 `qwen3.8-max-nothink` 模型条目）。`judgment` 路由 fallback 由 `deepseek-v4-flash` 改为 `qwen3.8-max`（统一运行时回退与新装降级目标）。后台 `SCENES` 与 `admin.controller` 相关枚举去 `transcribe`。
- **动机**：单多模态模型替代「文本模型 + VL 模型 + 两阶段确认」，减复杂度与一次模型往返；`qwen3.8-max` 全面替代 `qwen3.7-max`；判题不带 thinking 保速度。
- **落地**：`npx tsx src/scripts/migrate-qwen38-multimodal.ts` 幂等迁移已 seed 的库（顺序：插新模型 → 改路由 → 改判题路由 → 删 transcribe 路由 → 删旧模型行 → 重置遗留 flow 状态；受 primary FK 约束）；`tools/deploy/apply-llm-config.mjs`/`deploy.sh` 默认模型改名；重启后端或后台保存路由生效。
- **局限/待办**：`ai_dialogues.flow_state/pending_question(s)` 三列保留为死数据（未做破坏性迁移）；本地 llama.cpp 判题仍带 thinking（llama.cpp 忽略 `enable_thinking`，需 `chat_template_kwargs`，另议）；多模态替代两阶段后学生失去「识别对不对」确认，靠识别质量与 prompt 兜底；Qwen 账号曾欠费，公网模型可用性依赖账号状态。
- 设计 spec：`docs/superpowers/specs/2026-09-11-qwen38-multimodal-design.md`；实施计划 `docs/superpowers/plans/2026-09-11-qwen38-multimodal.md`。

---
```

- [ ] **Step 3: 同步设计文档**

- `docs/K12智学系统-AI-Agent中枢设计文档.md`：§4.4.2「两阶段设计」改为「直送多模态」（描述图片作为 `image_url` 部件随消息送给辅导模型）；全文 `qwen3.7-max` → `qwen3.8-max`；删除 `qwen-vl-max`/`qwen3-vl-plus`/`transcribe` 场景相关描述。用 `grep -n "qwen3.7-max\|qwen-vl\|qwen3-vl\|transcribe\|两阶段"` 定位后逐一处理。
- `docs/K12智学系统-数据库设计文档.md`：`qwen3.7-max` 示例改 `qwen3.8-max`；`ai_dialogues.flow_state`/`pending_question`/`pending_questions` 三列标注「已弃用（遗留死数据，勿再读写）」。

- [ ] **Step 4: 复查无遗漏**

Run:
```bash
grep -rn "qwen3\.7-max\|qwen-vl-max\|qwen3-vl-plus" --include=*.ts --include=*.tsx --include=*.yaml --include=*.mjs --include=*.sh apps/server/src apps/web/src tools 2>/dev/null
grep -rn "qwen3\.7-max" CLAUDE.md docs/ai-core-changelog.md docs/K12智学系统-AI-Agent中枢设计文档.md docs/K12智学系统-数据库设计文档.md
```
Expected: 代码/脚本中除历史 changelog/spec/plan 与 `dist/` 外无残留；上述四份文档无残留（历史条目除外）。

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/ai-core-changelog.md docs/K12智学系统-AI-Agent中枢设计文档.md docs/K12智学系统-数据库设计文档.md
git commit -m "docs(ai-core): record qwen3.8-max rename and multimodal/direct-image flow"
```

---

### Task 7: 手动验收（需 Qwen 账号可用 + 本地模型环境）

**Files:** 无

- [ ] **Step 1: 配置确认**：重启后端；管理后台确认模型池无 `qwen3.7-max`/VL、含 `qwen3.8-max`；路由 `judgment/math = local / qwen3.8-max`、无 `transcribe`。
- [ ] **Step 2: 图片直送**：辅线发送一张题图 → 直接进入辅导（**不再出现「你问的是这道题吧？确认/重新识别」**），模型正确读图并辅导。
- [ ] **Step 3: 一图多题**：发送含多道题的图片 → 模型按编号列出并询问从哪题开始。
- [ ] **Step 4: 判题**：训练模块提交一道需 AI 判定的题 → 正常返回；本地在线走本地、本地不可用回退 `qwen3.8-max`，日志/耗时符合预期（判题无 thinking）。
- [ ] **Step 5: 记录实测结论**：把 Step 2–4 的结果补进 `docs/ai-core-changelog.md` 2026-09-11 新条目的「局限/待办」下方（新增一行 `- **实测**：...`）；若多模态识别/多题体验差，开 follow-up 任务评估回补轻量确认。
