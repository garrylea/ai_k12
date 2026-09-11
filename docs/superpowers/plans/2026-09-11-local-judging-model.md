# 训练模块判题走本地模型 + 本地不可用回退 ds v4 flash — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让训练模块（专项/考试/错题）所有模型判题默认走本地 llama.cpp `Qwen3.8-27B`，本地模型任何失败时自动回退 `deepseek-v4-flash`。

**Architecture:** 判题链路 `JudgeCoreService.judgeQuestion → JudgmentCapability.judge`（`judgment` 场景）是唯一入口，改共享路由一处覆盖。Provider 层抽出真正的 `OpenAICompatibleClient` 基类（现状 `KimiClient` 被当基类用），新增 `LocalClient` 裁剪 llama.cpp 不支持的字段。`JudgmentCapability` 新增「primary 失败 → fallback 一次」逻辑（当前完全不读 fallback）。配置双落地：YAML（新装）+ 幂等 upsert 脚本（已 seed 的库）。

**Tech Stack:** Node.js + TypeScript ESM（`"type":"module"`）、NestJS、Vitest、Zod、js-yaml、mysql2、React（仅后台下拉一项）。

**Spec:** `docs/superpowers/specs/2026-09-11-local-judging-model-design.md`

## Global Constraints

- 所有命令默认在 `apps/server/` 下运行（除标注 `apps/web` 的步骤）。前端命令在 `apps/web/`。
- TS 严格模式、2 空格缩进；ESM 相对导入必须带 `.js` 后缀；类 PascalCase、函数/变量 camelCase。
- 不改 `hint`/`explanation`/`grading`/`tutoring`/`safety`/`structuring`/`transcribe` 场景；不改 `JudgeCoreService`。
- 不改 `seed-llm-config.ts` 的 skip-if-exists 语义。
- `Provider` 联合类型当前为 `'kimi' | 'qwen' | 'gemini' | 'deepseek'`，本计划加 `'local'`。
- `providerName` 字符串只进错误上下文；`'OpenAI-Compatible'` 是 kimi 现有值，必须保持，避免错误标签漂移。
- 无 emoji。Conventional Commits，常用 scope：`ai-core`、`admin`、`server`、`web`。
- 每个任务结束必须 `npm test` 全绿（当前 72 tests）+ `npm run build` 通过后再 commit。

---

## File Structure

**新增**

| 文件 | 职责 |
|---|---|
| `src/ai-core/infra/model-client/openai-compatible-client.ts` | OpenAI 兼容协议基类：chat / streamChat / buildRequestBody / calculateCost |
| `src/ai-core/infra/model-client/local-client.ts` | 本地 llama.cpp 子类：去掉 `enable_thinking` |
| `src/ai-core/infra/model-client/openai-compatible-client.test.ts` | 基类 buildRequestBody 单测 |
| `src/ai-core/infra/model-client/local-client.test.ts` | LocalClient buildRequestBody 单测 |
| `src/scripts/set-judging-local.ts` | 幂等 upsert local 模型 + judgment 路由到 DB |

**修改**

| 文件 | 改动 |
|---|---|
| `src/ai-core/types.ts` | `Provider` 加 `'local'` |
| `src/ai-core/infra/model-client/kimi-client.ts` | 变为 `extends OpenAICompatibleClient` 的薄子类 |
| `src/ai-core/infra/model-client/qwen-client.ts` | 换基类 |
| `src/ai-core/infra/model-client/deepseek-client.ts` | 换基类 |
| `src/ai-core/infra/model-client/index.ts` | 导入/分支 `local` |
| `src/ai-core/capabilities/judgment.capability.ts` | 新增 fallback |
| `src/ai-core/capabilities/judgment.capability.test.ts` | 新增回退用例 |
| `src/ai-core/infra/model-router.test.ts` | judgment 断言更新 |
| `src/ai-core/model-routes.yaml` | 新增 `local` 模型 + 改 `judgment` 路由 |
| `src/modules/admin/admin-models.service.ts` | `PROVIDER_TYPES` 加 `'local'` |
| `../../apps/web/src/pages/admin/AdminModelsPage.tsx` | `PROVIDER_TYPES` 加 `'local'` |
| `.env` / `.env.example` | `LOCAL_LLM_BASE_URL` / `LOCAL_LLM_API_KEY` |
| `CLAUDE.md` | 场景路由段更新 |
| `docs/ai-core-changelog.md` | 新条目 |

---

### Task 1: 抽出 `OpenAICompatibleClient` 基类（行为不变）

**Files:**
- Create: `src/ai-core/infra/model-client/openai-compatible-client.ts`
- Modify: `src/ai-core/infra/model-client/kimi-client.ts`（整体替换）
- Modify: `src/ai-core/infra/model-client/qwen-client.ts`（整体替换）
- Modify: `src/ai-core/infra/model-client/deepseek-client.ts`（整体替换）
- Test: `src/ai-core/infra/model-client/openai-compatible-client.test.ts`

**Interfaces:**
- Consumes: `src/ai-core/types.ts` 的 `ChatRequest`/`ChatResponse`/`StreamChunk`；`./types.js` 的 `ProviderAdapter`；`./errors.js` 的 `classifyError`。
- Produces:
  - `class OpenAICompatibleClient implements ProviderAdapter`，构造 `(apiKey: string, providerName?: string)`（默认 `'OpenAI-Compatible'`）。
  - `protected buildRequestBody(request: ChatRequest, stream: boolean): Record<string, unknown>`
  - `protected calculateCost(inputTokens: number, outputTokens: number, costPer1K: { input: number; output: number }): number`
  - `class KimiClient extends OpenAICompatibleClient`，构造 `(apiKey: string, providerName?: string)`（默认 `'Kimi'`）——签名与改动前完全一致。

- [ ] **Step 1: 写基类请求体测试（先失败）**

创建 `src/ai-core/infra/model-client/openai-compatible-client.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { OpenAICompatibleClient } from './openai-compatible-client.js';

const request = {
  model: {
    provider: 'kimi' as const, modelId: 'kimi-latest', baseUrl: 'https://api.moonshot.cn',
    apiKey: 'sk-x', contextWindow: 8, maxOutputTokens: 8,
    costPer1K: { input: 0, output: 0 }, supportsStreaming: true,
  },
  messages: [{ role: 'user' as const, content: 'hi' }],
  responseFormat: 'json_object' as const,
};

describe('OpenAICompatibleClient.buildRequestBody', () => {
  it('非流式请求体含 enable_thinking 与 response_format，不含 stream', () => {
    const body = (new OpenAICompatibleClient('sk-x') as any).buildRequestBody(request, false);
    expect(body.enable_thinking).toBe(true);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.stream).toBeUndefined();
  });

  it('流式请求体带 stream: true', () => {
    const body = (new OpenAICompatibleClient('sk-x') as any).buildRequestBody(request, true);
    expect(body.stream).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/ai-core/infra/model-client/openai-compatible-client.test.ts`
Expected: FAIL —— 无法解析导入 `./openai-compatible-client.js`（模块不存在）。

- [ ] **Step 3: 创建基类**

创建 `src/ai-core/infra/model-client/openai-compatible-client.ts`（把原 `kimi-client.ts` 实现原样搬入，仅抽出 `buildRequestBody`）：

```ts
import type { ChatRequest, ChatResponse, StreamChunk } from '../../types.js';
import type { ProviderAdapter } from './types.js';
import { classifyError } from './errors.js';

// OpenAI-compatible chat client. Kimi, Qwen, DeepSeek and local llama.cpp all
// speak this protocol, so KimiClient/QwenClient/DeepSeekClient/LocalClient
// extend this class and only differ in the provider label / request body.
export class OpenAICompatibleClient implements ProviderAdapter {
  constructor(protected apiKey: string, protected providerName = 'OpenAI-Compatible') {}

  /** Request body for /v1/chat/completions. Subclasses override to add or drop
   *  provider-specific fields (e.g. LocalClient omits enable_thinking). */
  protected buildRequestBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    return {
      model: request.model.modelId,
      messages: request.messages,
      temperature: request.temperature ?? 0.7,
      max_tokens: request.maxTokens ?? request.model.maxOutputTokens,
      stop: request.stopSequences,
      enable_thinking: true,
      ...(stream ? { stream: true } : {}),
      response_format: request.responseFormat === 'json_object' ? { type: 'json_object' } : undefined,
    };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    let response: Response;
    try {
      response = await fetch(`${request.model.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(this.buildRequestBody(request, false)),
        signal: AbortSignal.any([AbortSignal.timeout(request.timeout ?? 30000), ...(request.signal ? [request.signal] : [])]),
      });
    } catch (netErr) {
      // 网络错误(DNS/连接失败/abort)归一为 status=0 -> TimeoutError
      throw classifyError({
        provider: this.providerName,
        status: 0,
        body: { message: netErr instanceof Error ? netErr.message : String(netErr) },
        headers: new Headers(),
        modelId: request.model.modelId,
      });
    }

    if (!response.ok) {
      const raw = await response.text();
      let parsed: unknown = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { message: raw }; }
      throw classifyError({
        provider: this.providerName,
        status: response.status,
        body: parsed,
        headers: response.headers,
        modelId: request.model.modelId,
      });
    }

    const data = await response.json();
    const choice = data.choices[0];

    return {
      id: data.id,
      model: data.model,
      content: choice.message.content,
      // qwen3.7-max / deepseek emit reasoning_content with literal "\n" (backslash
      // + n) as line separators instead of real newlines. Normalize at source so
      // streaming, persistence, and history all see real newlines.
      reasoningContent: choice.message.reasoning_content
        ? choice.message.reasoning_content.replace(/\\n/g, '\n')
        : undefined,
      finishReason: choice.finish_reason,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        cost: this.calculateCost(data.usage?.prompt_tokens ?? 0, data.usage?.completion_tokens ?? 0, request.model.costPer1K),
      },
      latencyMs: 0,
    };
  }

  async *streamChat(request: ChatRequest): AsyncIterable<StreamChunk> {
    let response: Response;
    try {
      response = await fetch(`${request.model.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(this.buildRequestBody(request, true)),
        signal: AbortSignal.any([AbortSignal.timeout(request.timeout ?? 30000), ...(request.signal ? [request.signal] : [])]),
      });
    } catch (netErr) {
      // 网络错误(DNS/连接失败/abort)归一为 status=0 -> TimeoutError
      throw classifyError({
        provider: this.providerName,
        status: 0,
        body: { message: netErr instanceof Error ? netErr.message : String(netErr) },
        headers: new Headers(),
        modelId: request.model.modelId,
      });
    }

    if (!response.ok) {
      const raw = await response.text();
      let parsed: unknown = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { message: raw }; }
      throw classifyError({
        provider: this.providerName,
        status: response.status,
        body: parsed,
        headers: response.headers,
        modelId: request.model.modelId,
      });
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.reasoning_content) {
            yield { content: '', reasoningContent: delta.reasoning_content.replace(/\\n/g, '\n') };
          }
          if (delta?.content) {
            yield { content: delta.content };
          }
          if (parsed.choices?.[0]?.finish_reason) {
            yield { content: '', finishReason: parsed.choices[0].finish_reason };
          }
        } catch {
          // skip malformed SSE chunks
        }
      }
    }
  }

  protected calculateCost(inputTokens: number, outputTokens: number, costPer1K: { input: number; output: number }): number {
    return (inputTokens / 1000) * costPer1K.input + (outputTokens / 1000) * costPer1K.output;
  }
}
```

> 唯一有意保留的差异：流式请求体现在也带 `stop`（原 streamChat 不含）。`stop` 为 `undefined` 时 `JSON.stringify` 丢弃；现有调用方均不传 `stopSequences`，行为等价。

- [ ] **Step 4: 把 KimiClient 改成薄子类**

整体替换 `src/ai-core/infra/model-client/kimi-client.ts`：

```ts
import { OpenAICompatibleClient } from './openai-compatible-client.js';

// Kimi (Moonshot) exposes an OpenAI-compatible endpoint - reuse the shared client.
export class KimiClient extends OpenAICompatibleClient {
  constructor(apiKey: string, providerName = 'Kimi') {
    super(apiKey, providerName);
  }
}
```

- [ ] **Step 5: QwenClient / DeepSeekClient 换基类**

整体替换 `src/ai-core/infra/model-client/qwen-client.ts`：

```ts
import { OpenAICompatibleClient } from './openai-compatible-client.js';

// Qwen (DashScope) exposes an OpenAI-compatible endpoint - reuse the shared client.
export class QwenClient extends OpenAICompatibleClient {
  constructor(apiKey: string) {
    super(apiKey, 'Qwen');
  }
}
```

整体替换 `src/ai-core/infra/model-client/deepseek-client.ts`：

```ts
import { OpenAICompatibleClient } from './openai-compatible-client.js';

// DeepSeek exposes an OpenAI-compatible endpoint - reuse the shared client.
export class DeepSeekClient extends OpenAICompatibleClient {
  constructor(apiKey: string) {
    super(apiKey, 'DeepSeek');
  }
}
```

- [ ] **Step 6: 运行新测试确认通过**

Run: `npx vitest run src/ai-core/infra/model-client/openai-compatible-client.test.ts`
Expected: PASS（2 tests）。

- [ ] **Step 7: 跑全量测试与构建确认无回归**

Run: `npm test && npm run build`
Expected: 全部测试通过（在现有 72 基础上新增 2 个 base 测试）；tsc 无错误。

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/ai-core/infra/model-client/openai-compatible-client.ts \
        apps/server/src/ai-core/infra/model-client/openai-compatible-client.test.ts \
        apps/server/src/ai-core/infra/model-client/kimi-client.ts \
        apps/server/src/ai-core/infra/model-client/qwen-client.ts \
        apps/server/src/ai-core/infra/model-client/deepseek-client.ts
git commit -m "refactor(ai-core): extract OpenAICompatibleClient base from KimiClient"
```

---

### Task 2: 新增 `local` provider

**Files:**
- Modify: `src/ai-core/types.ts:17`
- Create: `src/ai-core/infra/model-client/local-client.ts`
- Modify: `src/ai-core/infra/model-client/index.ts`
- Modify: `src/modules/admin/admin-models.service.ts:7`
- Modify: `apps/web/src/pages/admin/AdminModelsPage.tsx:15`
- Test: `src/ai-core/infra/model-client/local-client.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `OpenAICompatibleClient`（`buildRequestBody` 可 override）。
- Produces: `class LocalClient extends OpenAICompatibleClient`，构造 `(apiKey: string)`；`ModelClient` 支持 `provider: 'local'`；`Provider` 联合类型含 `'local'`。

- [ ] **Step 1: `Provider` 加 `'local'`**

`src/ai-core/types.ts:17` 改为：

```ts
export type Provider = 'kimi' | 'qwen' | 'gemini' | 'deepseek' | 'local';
```

- [ ] **Step 2: 写 LocalClient 测试（先失败）**

创建 `src/ai-core/infra/model-client/local-client.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { LocalClient } from './local-client.js';
import { KimiClient } from './kimi-client.js';

const request = {
  model: {
    provider: 'local' as const, modelId: 'Qwen3.8-27B', baseUrl: 'http://192.168.1.8:12345',
    apiKey: 'local', contextWindow: 32768, maxOutputTokens: 4096,
    costPer1K: { input: 0, output: 0 }, supportsStreaming: true,
  },
  messages: [{ role: 'user' as const, content: 'hi' }],
  responseFormat: 'json_object' as const,
};

describe('LocalClient', () => {
  it('请求体不下发 enable_thinking（llama.cpp 非 DashScope 端点）', () => {
    const body = (new LocalClient('local') as any).buildRequestBody(request, false);
    expect(body.enable_thinking).toBeUndefined();
  });

  it('保留 response_format: json_object（判题 JSON 依赖）', () => {
    const body = (new LocalClient('local') as any).buildRequestBody(request, false);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('云端 OpenAI 兼容客户端仍下发 enable_thinking（行为不变）', () => {
    const body = (new KimiClient('sk-x') as any).buildRequestBody(request, false);
    expect(body.enable_thinking).toBe(true);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run src/ai-core/infra/model-client/local-client.test.ts`
Expected: FAIL —— 无法解析导入 `./local-client.js`。

- [ ] **Step 4: 创建 LocalClient**

创建 `src/ai-core/infra/model-client/local-client.ts`：

```ts
import type { ChatRequest } from '../../types.js';
import { OpenAICompatibleClient } from './openai-compatible-client.js';

// 本地 llama.cpp 服务（OpenAI 兼容）。它服务 Qwen3.8-27B 权重，但不是 DashScope
// 端点：去掉 enable_thinking（DashScope 专有的 thinking 开关），保留
// response_format（判题依赖 JSON 输出）。
export class LocalClient extends OpenAICompatibleClient {
  constructor(apiKey: string) {
    super(apiKey, 'Local');
  }

  protected buildRequestBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const body = super.buildRequestBody(request, stream);
    delete body.enable_thinking;
    return body;
  }
}
```

- [ ] **Step 5: ModelClient 分支接线**

`src/ai-core/infra/model-client/index.ts`：

1. 在 `import { KimiClient } from './kimi-client.js';` 后新增一行：
```ts
import { LocalClient } from './local-client.js';
```
2. 在 switch 的 `case 'gemini'` 后新增：
```ts
        case 'local': client = new LocalClient(key); break;
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run src/ai-core/infra/model-client/local-client.test.ts`
Expected: PASS（3 tests）。

- [ ] **Step 7: 后台 provider 下拉加 `'local'`**

`src/modules/admin/admin-models.service.ts:7` 改为：

```ts
export const PROVIDER_TYPES = ['kimi', 'qwen', 'deepseek', 'gemini', 'openai_compatible', 'local'] as const;
```

`apps/web/src/pages/admin/AdminModelsPage.tsx:15` 改为：

```ts
const PROVIDER_TYPES = ['kimi', 'qwen', 'deepseek', 'gemini', 'openai_compatible', 'local'];
```

- [ ] **Step 8: 前端 lint + 后端全量测试构建**

Run: `npm test && npm run build`（apps/server）
Expected: 全部测试通过（含新增 3 个 LocalClient 测试）；tsc 无错误。

Run: `npm run lint`（apps/web）
Expected: 无新增错误（该改动只加一个字符串常量）。

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/ai-core/types.ts \
        apps/server/src/ai-core/infra/model-client/local-client.ts \
        apps/server/src/ai-core/infra/model-client/local-client.test.ts \
        apps/server/src/ai-core/infra/model-client/index.ts \
        apps/server/src/modules/admin/admin-models.service.ts \
        apps/web/src/pages/admin/AdminModelsPage.tsx
git commit -m "feat(ai-core): add local (llama.cpp) provider for judging"
```

---

### Task 3: `JudgmentCapability` 失败回退

**Files:**
- Modify: `src/ai-core/capabilities/judgment.capability.ts`（整体替换）
- Modify: `src/ai-core/capabilities/judgment.capability.test.ts`（整体替换）

**Interfaces:**
- Consumes: Task 2 的 `Provider` 含 `'local'`；`src/ai-core/types.ts` 的 `RoutedModel`、`PromptBuildResult`；`src/ai-core/infra/model-router.js` 的 `ModelRouter`。
- Produces: `JudgmentCapabilityDeps` 增可选 `modelRouter?: ModelRouter`；`judge()` 行为 = primary 成功即返回，任何失败且有 fallback 时用 fallback 重试一次，两者皆败抛组合错误。

- [ ] **Step 1: 写回退测试（先失败）**

整体替换 `src/ai-core/capabilities/judgment.capability.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JudgmentCapability } from './judgment.capability.js';
import type { ModelClient } from '../infra/model-client/index.js';
import type { ModelRouter } from '../infra/model-router.js';
import type { RoutedModel } from '../types.js';

const mockChat = vi.fn();
const mockModelClient = { chat: mockChat } as unknown as ModelClient;

const primaryModel: RoutedModel = {
  provider: 'local', modelId: 'Qwen3.8-27B', baseUrl: 'http://192.168.1.8:12345', apiKey: 'local',
  contextWindow: 32768, maxOutputTokens: 4096, costPer1K: { input: 0, output: 0 }, supportsStreaming: true,
};
const fallbackModel: RoutedModel = {
  provider: 'deepseek', modelId: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x',
  contextWindow: 131072, maxOutputTokens: 65536, costPer1K: { input: 0.001, output: 0.004 }, supportsStreaming: true,
};

function routerWith(primary: RoutedModel, fallback?: RoutedModel): ModelRouter {
  return { route: () => ({ primary, fallback, reason: 'test' }) } as unknown as ModelRouter;
}

const judgeRequest = {
  questionContent: '解方程 $x^2-4=0$',
  standardAnswer: '$x=\\pm 2$',
  reference: '',
  studentAnswer: '$x=2$',
  subject: 'math' as const,
  questionType: 'calculation' as const,
};

beforeEach(() => mockChat.mockReset());

describe('JudgmentCapability', () => {
  it('答错返回 isCorrect=false + errorType（不再生成 analysis）', async () => {
    mockChat.mockResolvedValueOnce({
      content: '{"isCorrect":false,"errorType":"calculation"}',
      reasoningContent: '',
    });
    const cap = new JudgmentCapability({ modelClient: mockModelClient });
    const r = await cap.judge(judgeRequest);
    expect(r.isCorrect).toBe(false);
    expect(r.analysis ?? null).toBeNull();
    expect(r.errorType).toBe('calculation');
  });

  it('答对返回 isCorrect=true', async () => {
    mockChat.mockResolvedValueOnce({
      content: '{"isCorrect":true,"errorType":null}',
      reasoningContent: '',
    });
    const r = await new JudgmentCapability({ modelClient: mockModelClient }).judge({
      questionContent: 'q',
      standardAnswer: 'a',
      reference: '',
      studentAnswer: 'a',
      subject: 'math',
      questionType: 'calculation',
    });
    expect(r.isCorrect).toBe(true);
  });

  it('本地模型失败时回退到 ds v4 flash', async () => {
    mockChat
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 192.168.1.8:12345'))
      .mockResolvedValueOnce({ content: '{"isCorrect":true}', reasoningContent: '' });
    const cap = new JudgmentCapability({ modelClient: mockModelClient, modelRouter: routerWith(primaryModel, fallbackModel) });
    const r = await cap.judge(judgeRequest);
    expect(r.isCorrect).toBe(true);
    expect(mockChat).toHaveBeenCalledTimes(2);
    expect(mockChat.mock.calls[0][0].model.modelId).toBe('Qwen3.8-27B');
    expect(mockChat.mock.calls[1][0].model.modelId).toBe('deepseek-v4-flash');
  });

  it('primary 返回不可解析内容时也回退（任何失败都回退）', async () => {
    mockChat
      .mockResolvedValueOnce({ content: '这不是 JSON', reasoningContent: '' })
      .mockResolvedValueOnce({ content: '{"isCorrect":true}', reasoningContent: '' });
    const cap = new JudgmentCapability({ modelClient: mockModelClient, modelRouter: routerWith(primaryModel, fallbackModel) });
    const r = await cap.judge(judgeRequest);
    expect(r.isCorrect).toBe(true);
    expect(mockChat).toHaveBeenCalledTimes(2);
  });

  it('primary 成功时不调用 fallback', async () => {
    mockChat.mockResolvedValueOnce({ content: '{"isCorrect":false,"errorType":"calculation"}', reasoningContent: '' });
    const cap = new JudgmentCapability({ modelClient: mockModelClient, modelRouter: routerWith(primaryModel, fallbackModel) });
    const r = await cap.judge(judgeRequest);
    expect(r.isCorrect).toBe(false);
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(mockChat.mock.calls[0][0].model.modelId).toBe('Qwen3.8-27B');
  });

  it('无 fallback 时 primary 失败直接抛错', async () => {
    mockChat.mockRejectedValueOnce(new Error('local down'));
    const cap = new JudgmentCapability({ modelClient: mockModelClient, modelRouter: routerWith(primaryModel) });
    await expect(cap.judge(judgeRequest)).rejects.toThrow('local down');
    expect(mockChat).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/ai-core/capabilities/judgment.capability.test.ts`
Expected: FAIL —— 新增 4 个回退用例失败（`modelRouter` 未接线，primary 抛错后不会调 fallback；`mockChat` 只被调用 1 次）。

- [ ] **Step 3: 实现 fallback**

整体替换 `src/ai-core/capabilities/judgment.capability.ts`：

```ts
import { z } from 'zod';
import type { JudgmentRequest, JudgmentResult, RoutedModel, PromptBuildResult } from '../types.js';
import { timeoutConfig } from '../config.js';
import { ModelRouter } from '../infra/model-router.js';
import { getModelConfigRegistry } from '../infra/model-config-registry.js';
import { PromptBuilder } from '../infra/prompt-builder.js';
import { ModelClient } from '../infra/model-client/index.js';
import { ResponseParser } from '../infra/response-parser.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const JudgmentResultSchema = z.object({
  isCorrect: z.boolean(),
  analysis: z.string().nullable().optional(),
  errorType: z.enum(['logic', 'calculation', 'format', 'missing']).nullable().optional(),
});

export interface JudgmentCapabilityDeps {
  modelClient?: ModelClient;
  /** 可测性：测试注入 mock router，避免依赖全局 ModelConfigRegistry / YAML。 */
  modelRouter?: ModelRouter;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class JudgmentCapability {
  private modelRouter: ModelRouter;
  private promptBuilder: PromptBuilder;
  private modelClient: ModelClient;
  private responseParser = new ResponseParser();

  constructor(deps?: JudgmentCapabilityDeps) {
    this.modelRouter = deps?.modelRouter ?? new ModelRouter(getModelConfigRegistry());
    this.promptBuilder = new PromptBuilder(resolve(__dirname, '../prompts'));
    this.modelClient = deps?.modelClient ?? new ModelClient();
  }

  async judge(request: JudgmentRequest): Promise<JudgmentResult> {
    const routeResult = this.modelRouter.route({
      scene: 'judgment',
      subject: request.subject,
    });

    const promptResult = await this.promptBuilder.build({
      capability: 'judgment',
      subject: request.subject,
      questionType: request.questionType,
      context: {
        student: { grade: '', gradeLevel: '' },
        question: {
          content: request.questionContent,
          answer: request.standardAnswer,
          rubric: request.reference,
        },
        studentAnswer: request.studentAnswer,
        userMessage: '请判断对错',
      },
    });

    // primary（本地模型）任何失败 -> 回退 fallback（ds v4 flash）一次。
    try {
      return await this.callModel(routeResult.primary, promptResult);
    } catch (primaryErr) {
      if (!routeResult.fallback) throw primaryErr;
      try {
        return await this.callModel(routeResult.fallback, promptResult);
      } catch (fallbackErr) {
        throw new Error(
          `Judgment failed: primary(${routeResult.primary.modelId})=${errorMessage(primaryErr)}; ` +
          `fallback(${routeResult.fallback.modelId})=${errorMessage(fallbackErr)}`,
        );
      }
    }
  }

  private async callModel(model: RoutedModel, promptResult: PromptBuildResult): Promise<JudgmentResult> {
    const chatResponse = await this.modelClient.chat({
      model,
      messages: promptResult.messages,
      responseFormat: 'json_object',
      timeout: timeoutConfig.timeout.judgment ?? timeoutConfig.timeout.default,
    });

    const parseResult = this.responseParser.parse<JudgmentResult>({
      rawContent: chatResponse.content,
      mode: 'json',
      schema: JudgmentResultSchema,
    });

    if (!parseResult.success || !parseResult.data) {
      throw new Error(`Judgment parse failed: ${parseResult.errors?.join(', ')}`);
    }

    return { ...parseResult.data, reasoning: chatResponse.reasoningContent };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/ai-core/capabilities/judgment.capability.test.ts`
Expected: PASS（6 tests）。

- [ ] **Step 5: 全量测试与构建**

Run: `npm test && npm run build`
Expected: 全部测试通过（judgment 测试 6 个）；tsc 无错误。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/ai-core/capabilities/judgment.capability.ts \
        apps/server/src/ai-core/capabilities/judgment.capability.test.ts
git commit -m "feat(ai-core): fall back to ds v4 flash when local judging model fails"
```

---

### Task 4: 配置层（env + YAML 路由）

**Files:**
- Modify: `apps/server/.env`（DEEPSEEK 块之后、`# Database` 之前）
- Modify: `apps/server/.env.example`（`DEEPSEEK_API_KEY=` 之后）
- Modify: `src/ai-core/model-routes.yaml`（新增 `local` 模型 + 改 `judgment` 路由）
- Modify: `src/ai-core/infra/model-router.test.ts:47-52`

**Interfaces:**
- Consumes: Task 2 的 provider `'local'`；Task 3 的 fallback 逻辑读取 `routeResult.fallback`。
- Produces: `judgment/math` 路由 = primary `local`（modelId `Qwen3.8-27B`）、fallback `deepseek-v4-flash`；env 变量 `LOCAL_LLM_BASE_URL` / `LOCAL_LLM_API_KEY`。

- [ ] **Step 1: env 增加本地模型两项**

`apps/server/.env` 在 `DEEPSEEK_API_KEY=...` 行之后插入：

```
# 本地 llama.cpp 判题模型（训练模块判题主模型；不可用回退 deepseek-v4-flash）
LOCAL_LLM_BASE_URL=http://192.168.1.8:12345
LOCAL_LLM_API_KEY=local
```

`apps/server/.env.example` 在 `DEEPSEEK_API_KEY=` 行之后插入同样三行（`LOCAL_LLM_API_KEY=local`）。

- [ ] **Step 2: YAML 新增 `local` 模型**

`src/ai-core/model-routes.yaml` 在 `deepseek-v4-flash:` 块之后、`# Task 14a` 之前插入：

```yaml
  # 训练模块判题主模型：本地 llama.cpp 服务（OpenAI 兼容）。modelId 写字面量
  # （测试与无 .env 的全新克隆结果确定）；baseUrl/apiKey 走 env。
  local:
    provider: local
    modelId: Qwen3.8-27B
    baseUrl: ${LOCAL_LLM_BASE_URL}
    apiKey: ${LOCAL_LLM_API_KEY}
    contextWindow: 32768
    maxOutputTokens: 4096
    costPer1K:
      input: 0
      output: 0
    supportsStreaming: true
```

- [ ] **Step 3: YAML 改 judgment 路由**

`src/ai-core/model-routes.yaml` 的 `judgment:` 块整体替换为：

```yaml
  judgment:
    - subject: math
      # 训练模块（专项/考试/错题）判题默认走本地 Qwen3.8-27B；
      # 本地不可用回退 deepseek-v4-flash（快模型，实测同题 ~19s 判对）。
      primary: local
      fallback: deepseek-v4-flash
```

- [ ] **Step 4: 更新路由测试断言**

`src/ai-core/infra/model-router.test.ts` 的 `routes math judgment ...` 用例整体替换为：

```ts
  it('routes math judgment to local primary with ds-v4-flash fallback', () => {
    // 训练模块判题默认走本地 llama.cpp Qwen3.8-27B；本地不可用回退 deepseek-v4-flash
    const result = router.route({ scene: 'judgment', subject: 'math' });
    expect(result.primary.modelId).toBe('Qwen3.8-27B');
    expect(result.fallback?.modelId).toBe('deepseek-v4-flash');
  });
```

- [ ] **Step 5: 运行路由测试确认通过**

Run: `npx vitest run src/ai-core/infra/model-router.test.ts`
Expected: PASS（全部用例，含更新的 judgment 断言）。

- [ ] **Step 6: 全量测试与构建**

Run: `npm test && npm run build`
Expected: 全部测试通过；tsc 无错误。

- [ ] **Step 7: Commit**

```bash
git add apps/server/.env.example \
        apps/server/src/ai-core/model-routes.yaml \
        apps/server/src/ai-core/infra/model-router.test.ts
git commit -m "feat(ai-core): route math judgment to local model with ds-v4-flash fallback"
```

> `apps/server/.env` 被 `apps/server/.gitignore:3` 忽略，**不提交**。`LOCAL_LLM_BASE_URL`/`LOCAL_LLM_API_KEY` 需从 `.env.example` 补进本地 `.env`（Task 5 脚本与运行时都依赖）。

---

### Task 5: DB upsert 脚本

**Files:**
- Create: `src/scripts/set-judging-local.ts`

**Interfaces:**
- Consumes: Task 4 的 YAML（`routeConfig.models.local`、`routeConfig.routes.judgment[0]`）；`src/common/utils/api-key-crypto.js` 的 `encryptApiKey`。
- Produces: 幂等脚本，`llm_models` 的 `local` 行 + `llm_routes` 的 `judgment/math` 行被 upsert。无导出 API。

- [ ] **Step 1: 创建 upsert 脚本**

创建 `src/scripts/set-judging-local.ts`：

```ts
/**
 * 把判题主模型切到本地 llama.cpp（读 YAML models.local + routes.judgment），
 * 幂等 upsert 进 llm_models / llm_routes。已 seed 的库靠本脚本更新
 * （seed-llm-config.ts 是 skip-if-exists，不会更新既有行）。
 *
 * 运行：cd apps/server && npx tsx src/scripts/set-judging-local.ts
 * 生效：脚本不改内存 registry —— 重启后端，或后台保存一次路由触发 reload。
 */
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import mysql from 'mysql2/promise';
import { routeConfig } from '../ai-core/config.js';
import { encryptApiKey } from '../common/utils/api-key-crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../.env') });

async function main() {
  const model = routeConfig.models.local;
  const rule = routeConfig.routes.judgment?.find((r) => r.subject === 'math');

  if (!model) throw new Error('YAML 缺少 models.local');
  if (!rule) throw new Error('YAML 缺少 routes.judgment（subject=math）');
  if (!model.baseUrl) throw new Error('LOCAL_LLM_BASE_URL 未配置（检查 apps/server/.env）');
  if (!model.apiKey) throw new Error('LOCAL_LLM_API_KEY 未配置（检查 apps/server/.env）');

  const pool = mysql.createPool({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'ai_k12',
    password: process.env.DB_PASS ?? 'ai_k12',
    database: process.env.DB_NAME ?? 'ai_k12',
  });

  // 1) llm_models upsert（FK 要求 primary_model_key 先存在）
  const [modelRows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT id FROM llm_models WHERE model_key = ?', ['local']);
  const encryptedKey = encryptApiKey(model.apiKey);
  if (modelRows.length > 0) {
    await pool.execute(
      `UPDATE llm_models
         SET name = ?, provider_type = ?, model_id = ?, base_url = ?, api_key = ?,
             context_window = ?, max_output_tokens = ?, is_enabled = 1,
             updated_at = CURRENT_TIMESTAMP(3)
       WHERE model_key = ?`,
      [model.modelId, model.provider, model.modelId, model.baseUrl, encryptedKey,
       model.contextWindow, model.maxOutputTokens, 'local']);
    console.log('[judging-local] 模型 local 已更新');
  } else {
    await pool.execute(
      `INSERT INTO llm_models
         (model_key, name, provider_type, model_id, base_url, api_key, context_window, max_output_tokens, is_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ['local', model.modelId, model.provider, model.modelId, model.baseUrl, encryptedKey,
       model.contextWindow, model.maxOutputTokens]);
    console.log('[judging-local] 模型 local 已插入');
  }

  // 2) llm_routes upsert
  const [routeRows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT id FROM llm_routes WHERE scene = ? AND subject = ?', ['judgment', 'math']);
  if (routeRows.length > 0) {
    await pool.execute(
      `UPDATE llm_routes
         SET primary_model_key = ?, fallback_model_key = ?, updated_at = CURRENT_TIMESTAMP(3)
       WHERE scene = ? AND subject = ?`,
      [rule.primary, rule.fallback ?? null, 'judgment', 'math']);
    console.log(`[judging-local] 路由 judgment/math 已更新 -> ${rule.primary} / ${rule.fallback ?? '-'}`);
  } else {
    await pool.execute(
      'INSERT INTO llm_routes (scene, subject, primary_model_key, fallback_model_key) VALUES (?, ?, ?, ?)',
      ['judgment', 'math', rule.primary, rule.fallback ?? null]);
    console.log(`[judging-local] 路由 judgment/math 已插入 -> ${rule.primary} / ${rule.fallback ?? '-'}`);
  }

  console.log('[judging-local] 完成。重启后端（或后台保存路由）后生效。');
  await pool.end();
}

main().catch((e) => { console.error('[judging-local] 失败:', e); process.exit(1); });
```

- [ ] **Step 2: 构建确认脚本类型正确**

Run: `npm run build`
Expected: tsc 无错误（脚本被 tsconfig 包含）。

- [ ] **Step 3: 运行脚本（写开发库）**

Run: `npx tsx src/scripts/set-judging-local.ts`
Expected 输出包含：
```
[judging-local] 模型 local 已插入   （或「已更新」）
[judging-local] 路由 judgment/math 已更新 -> local / deepseek-v4-flash
[judging-local] 完成。重启后端（或后台保存路由）后生效。
```

- [ ] **Step 4: 校验 DB 结果**

Run:
```bash
mysql -uai_k12 -pai_k12 ai_k12 -e "SELECT model_key, provider_type, model_id, base_url, is_enabled FROM llm_models WHERE model_key='local'; SELECT scene, subject, primary_model_key, fallback_model_key FROM llm_routes WHERE scene='judgment';"
```
Expected: `local | local | Qwen3.8-27B | http://192.168.1.8:12345 | 1`；`judgment | math | local | deepseek-v4-flash`。

- [ ] **Step 5: 幂等复验**

Run: `npx tsx src/scripts/set-judging-local.ts`
Expected: 输出「模型 local 已更新」「路由 judgment/math 已更新」，DB 无重复行（Step 4 查询结果不变）。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/scripts/set-judging-local.ts
git commit -m "feat(server): add idempotent script to point judgment route at local model"
```

---

### Task 6: 文档同步

**Files:**
- Modify: `CLAUDE.md:178`（ai-core「场景路由（勿随意切换）」条目）
- Modify: `docs/ai-core-changelog.md`（顶部新增 2026-09-11 条目）

**Interfaces:**
- Consumes: Task 4/5 的实际配置值与脚本名。
- Produces: 无代码接口。

- [ ] **Step 1: 更新 CLAUDE.md 场景路由条目**

`CLAUDE.md:178` 该行整体替换为（保留原有其它场景信息，只改 judgment 部分）：

```
- **场景路由（勿随意切换）**：judgment（训练模块专项/考试/错题判题）primary 是 `local`（本地 llama.cpp `Qwen3.8-27B`，`LOCAL_LLM_BASE_URL`/`LOCAL_LLM_API_KEY`），fallback 是 `deepseek-v4-flash`——`JudgmentCapability` 对 primary 任何失败（连接/超时/4xx/5xx/解析失败）自动回退一次；grading/structuring/hint 的 primary 仍是 `deepseek-v4-flash`（快模型，同题 ~19s 判对）；`qwen3.7-max` 是 reasoner（难几何题 >90s 仍超时），只作 fallback；tutoring 辅导主模型 `qwen3.7-max`；图片转录走独立 `transcribe` 场景（`qwen3-vl-plus`，fallback qwen-vl-max），辅导不因带图切换模型。已 seed 的库用 `npx tsx src/scripts/set-judging-local.ts` 幂等切换路由（YAML 只服务新装/DB 空时）。
```

- [ ] **Step 2: 追加 changelog 条目**

在 `docs/ai-core-changelog.md` 的 `---`（第 12 行之后）之上、`## 2026-09-10 判题体系重构…` 之前插入：

```markdown
## 2026-09-11 训练模块判题默认走本地模型（失败回退 ds v4 flash）

- **变更摘要**：`judgment` 场景 primary 由 `deepseek-v4-flash` 改为 `local`（本地 llama.cpp `Qwen3.8-27B`，OpenAI 兼容，`LOCAL_LLM_BASE_URL`/`LOCAL_LLM_API_KEY`），fallback 改为 `deepseek-v4-flash`。`JudgmentCapability` 新增失败回退：primary 任何失败（连接拒绝/超时/4xx/5xx/返回解析不了）→ fallback 重试一次；两者皆败才抛错（`JudgeCoreService` 仍映射 503 不变）。覆盖训练模块专项/考试/错题全部模型判题（三者同走 `judgeQuestion → JudgmentCapability`）；课堂练习共用该场景，一并切到本地模型。Provider 层抽出 `OpenAICompatibleClient` 基类（原 `KimiClient` 一直兼任基类但命名误导），`KimiClient`/`QwenClient`/`DeepSeekClient`/新增 `LocalClient` 各自为其薄子类；`LocalClient` 去掉 `enable_thinking`（llama.cpp 非 DashScope 端点），保留 `response_format`。`Provider` 联合类型与后台 provider 下拉新增 `local`。
- **动机**：训练模块判题量大，走本地模型省调用成本；本地不可用时必须自动兜底，学生判题不能因本地服务挂掉而失败。
- **落地**：`model-routes.yaml` 新增 `local` 模型 + judgment 路由；`npx tsx src/scripts/set-judging-local.ts` 幂等 upsert 到已 seed 的库（`seed-llm-config.ts` 是 skip-if-exists，无法更新既有行）；运行后需重启后端或后台保存路由触发 `registry.reload()`。
- **局限/待办**：本地不可用时 `ModelClient` 内置重试（2 次 + 退避）后才回退，单次判题多约 1–3s（未为 local 单独调 `retry.yaml`）；llama.cpp 对 `response_format: json_object` 的兼容性与本地 27B 判题准确率待实测；无本地健康检查/preflight。
- 设计 spec：`docs/superpowers/specs/2026-09-11-local-judging-model-design.md`；实施计划 `docs/superpowers/plans/2026-09-11-local-judging-model.md`。

---
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/ai-core-changelog.md docs/superpowers/specs/2026-09-11-local-judging-model-design.md
git commit -m "docs(ai-core): record local judging model routing and fallback"
```

> 若 spec 在 Task 4 期间有修正（如 modelId 字面量），一并放进本 commit。

---

### Task 7: 手动验收（本地模型在线/离线两态）

**Files:** 无（纯运行验证）

- [ ] **Step 1: 启动后端并确认路由生效**

Run: `npm run start:dev`（apps/server；实际执行 `node --watch --loader @swc-node/register/esm src/main.ts`）
然后 `curl -s localhost:3000/api/admin/routes`（带管理员 JWT）或直接查 DB，确认 `judgment/math` = `local / deepseek-v4-flash`。

- [ ] **Step 2: 本地模型在线时判一题**

本地 llama.cpp 在线（`curl -s http://192.168.1.8:12345/v1/models` 有响应）时，用训练判题接口提交一道 `fill_blank`/`calculation` 且答案不等价于标准答案的题（会走 AI 路由），确认返回正常且耗时符合本地推理预期。

- [ ] **Step 3: 本地模型离线时判一题（关键验收）**

停掉本地 llama.cpp（或改 `.env` 的 `LOCAL_LLM_BASE_URL` 指向不可达端口并重启后端），重复 Step 2，确认判题仍成功返回 —— 即回退 `deepseek-v4-flash` 生效。预期多等约 1–3s（重试退避）+ ds 调用时间。

- [ ] **Step 4: 记录实测结论**

把 Step 2/3 的实际耗时与是否成功写入 `docs/ai-core-changelog.md` 的 2026-09-11 条目「局限/待办」下方（新增一行 `- **实测**：...`），若 llama.cpp 拒绝 `response_format` 则同时新建 follow-up 任务改 `LocalClient.buildRequestBody`。
