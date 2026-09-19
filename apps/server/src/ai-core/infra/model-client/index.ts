import type { ChatRequest, ChatResponse, ChatMessage, StreamChunk, RetryOptions, RoutedModel } from '../../types.js';
import { contentToText, LLMClientError } from '../../types.js';
import { timeoutConfig, getApiKeyByProvider } from '../../config.js';
import type { ProviderAdapter } from './types.js';
import { callWithRetry } from './errors.js';
import { emitLlmCall } from '../llm-call-log.js';
import { getRequestContext } from '../request-context.js';
import { KimiClient } from './kimi-client.js';
import { LocalClient } from './local-client.js';
import { estimateTokens } from '../usage-estimate.js';

export { LLAMA_CPP_NO_THINKING_BODY } from './local-client.js';
import { QwenClient } from './qwen-client.js';
import { DeepSeekClient } from './deepseek-client.js';
import { GeminiClient } from './gemini-client.js';

/**
 * 估算**请求侧**的输入 token。输入与输出相互独立，各用自己的数据源：
 * 输入 = request.messages 的文本，输出 = 响应正文（见 buildStreamUsage）。
 * 用 contentToText 兼容多模态消息（ContentPart[] 只取 text 部分）。
 */
function estimateInputTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(contentToText(m.content)), 0);
}

/**
 * 流式 usage 的三级降级：
 *   1) 端点回了 usage -> provider，按真值算钱
 *   2) 拿不到 -> 输入/输出**分别估算** -> estimated（两段都来自估算，故共用一个来源标签；
 *      端点要么两段都给、要么都不给，不存在只估一段的情况）
 *   3) 请求与响应都为空 -> unavailable，token/cost 写 NULL（**不写 0**）
 */
function buildStreamUsage(
  providerUsage: { inputTokens: number; outputTokens: number } | null,
  estimatedInputTokens: number,
  content: string,
  reasoningContent: string,
  costPer1K: { input: number; output: number },
): ChatResponse['usage'] {
  if (providerUsage) {
    const { inputTokens, outputTokens } = providerUsage;
    return {
      inputTokens,
      outputTokens,
      cost: (inputTokens / 1000) * costPer1K.input + (outputTokens / 1000) * costPer1K.output,
      source: 'provider',
    };
  }
  const inputTokens = estimatedInputTokens;
  const outputTokens = estimateTokens(content) + estimateTokens(reasoningContent);
  if (inputTokens === 0 && outputTokens === 0) {
    return { inputTokens: null, outputTokens: null, cost: null, source: 'unavailable' };
  }
  return {
    inputTokens,
    outputTokens,
    cost: (inputTokens / 1000) * costPer1K.input + (outputTokens / 1000) * costPer1K.output,
    source: 'estimated',
  };
}

export class ModelClient {
  private providers = new Map<string, ProviderAdapter>();
  private retryOptions: RetryOptions;
  private providerOverrides?: Map<string, ProviderAdapter>;

  constructor(opts?: { retryOptions?: RetryOptions; providers?: Map<string, ProviderAdapter> }) {
    this.retryOptions = opts?.retryOptions ?? {
      maxRetries: timeoutConfig.retry.maxRetries,
      baseDelayMs: timeoutConfig.retry.baseDelayMs,
      maxBackoffMs: timeoutConfig.retry.maxBackoffMs,
      onRetry: timeoutConfig.retry.onRetry,
    };
    this.providerOverrides = opts?.providers;
  }

  private getProvider(provider: string, apiKey?: string): ProviderAdapter {
    // 缓存 key：provider + apiKey 指纹（同 provider 不同 key 共存；无 apiKey 走 env）
    const cacheKey = apiKey ? `${provider}:${apiKey}` : provider;
    if (this.providers.has(cacheKey)) return this.providers.get(cacheKey)!;

    let client: ProviderAdapter;
    if (this.providerOverrides?.has(provider)) {
      client = this.providerOverrides.get(provider)!;
    } else {
      // 优先用模型条目自带 apiKey（DB 自定义模型），env 兜底
      const key = apiKey || getApiKeyByProvider(provider);
      switch (provider) {
        case 'kimi': client = new KimiClient(key, 'OpenAI-Compatible'); break;
        case 'qwen': client = new QwenClient(key); break;
        case 'deepseek': client = new DeepSeekClient(key); break;
        case 'gemini': client = new GeminiClient(key); break;
        case 'local': client = new LocalClient(key); break;
        default: throw new Error(`Unknown provider: ${provider}`);
      }
    }
    this.providers.set(cacheKey, client);
    return client;
  }

  /**
   * Chat with the model. Defaults to streaming (stream !== false): consumes
   * provider.streamChat and aggregates content + reasoningContent (thinking)
   * into a ChatResponse. stream=false falls back to non-streaming provider.chat.
   *
   * gemini is forced to non-streaming until streamGenerateContent is implemented
   * (TODO: needs GEMINI_API_KEY). Wrapped in callWithRetry (full-jitter backoff +
   * Retry-After + onRetry); non-retryable errors throw immediately.
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const provider = this.getProvider(request.model.provider, request.model.apiKey);
    const startTime = Date.now();
    const useStream = request.stream !== false && request.model.provider !== 'gemini';
    // callWithRetry 会**重复调用同一个闭包**，所以闭包内自增即为 attempt（1-based）；
    // 每次尝试（含失败与最终放弃的那次）都要落一行账本。
    let attempt = 0;

    const run = async (): Promise<ChatResponse> => {
      attempt += 1;
      const attemptStart = Date.now();
      try {
        const response = useStream
          ? await this.aggregateStream(provider, request, startTime)
          : { ...(await provider.chat(request)), latencyMs: Date.now() - startTime };
        this.recordCall(request, attempt, useStream, response.usage, Date.now() - attemptStart, null);
        return response;
      } catch (err) {
        this.recordCall(request, attempt, useStream, null, Date.now() - attemptStart, err);
        throw err;
      }
    };

    return callWithRetry(run, this.retryOptions);
  }

  /**
   * 写一条账本。**永不抛**（emitLlmCall 内部吞异常），也永不 await。
   * 归因优先级：request.meta（后台路径显式传）> model 上的 router 打标 > ALS 上下文。
   *
   * 入参收的是 `usage` 而不是整个 `ChatResponse`——因为真流式那条路径（见 streamChat）
   * 没有 ChatResponse 可传，只有边透传边累积出来的一份 usage。
   */
  private recordCall(
    request: ChatRequest,
    attempt: number,
    useStream: boolean,
    usage: ChatResponse['usage'] | null,
    latencyMs: number,
    err: unknown,
  ): void {
    const model = request.model as RoutedModel;
    const ctx = getRequestContext();
    const llmErr = err instanceof LLMClientError ? err : null;
    // 区分「没传 meta.studentId」与「显式传了 null」：后者表示**明确不归属**
    // （如题目级缓存，不属任何学生），不能被 ALS 兜底覆盖。
    const metaHasStudentId = request.meta !== undefined && 'studentId' in request.meta;
    const studentId = metaHasStudentId ? (request.meta!.studentId ?? null) : (ctx?.studentId ?? null);
    // 显式声明「不归属」时，连带把 request_id 也置空：request_id 是 api_request_logs 的
    // join 键，而那张表的 student_id 是**真实学生**。若这里仍带上当时恰好占着上下文的
    // request_id，将来 join 会把这次调用重新算到那个学生头上——正是「显式不归属」要避免的事。
    const requestId = metaHasStudentId && studentId === null ? null : (ctx?.requestId ?? null);
    emitLlmCall({
      requestId,
      studentId,
      dialogueId: request.meta?.dialogueId ?? null,
      scene: request.meta?.scene ?? model.scene ?? null,
      subject: request.meta?.subject ?? model.subject ?? null,
      capability: request.meta?.capability ?? null,
      modelKey: model.modelKey ?? null,
      modelId: request.model.modelId ?? null,
      provider: request.model.provider,
      attempt,
      requestKind: useStream ? 'stream' : 'chat',
      isFallback: model.isFallbackEntry === true,
      success: usage !== null,
      errorType: llmErr ? llmErr.name : err ? ((err as Error).name || 'Error') : null,
      httpStatus: llmErr ? llmErr.statusCode : null,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      usageSource: usage?.source ?? 'unavailable',
      latencyMs,
    });
  }

  /**
   * Aggregate a provider's streamChat into a single ChatResponse. Collects
   * content + reasoningContent (thinking). usage: provider-reported when the
   * endpoint returns it (stream_options.include_usage), otherwise estimated
   * from the request (input) and the response body (output); NULL when neither
   * is measurable.
   */
  private async aggregateStream(provider: ProviderAdapter, request: ChatRequest, startTime: number): Promise<ChatResponse> {
    let content = '';
    let reasoningContent = '';
    let finishReason: ChatResponse['finishReason'] = 'stop';
    // 端点在最后一个 chunk 里回传的 usage（需 stream_options.include_usage）
    let providerUsage: { inputTokens: number; outputTokens: number } | null = null;

    for await (const chunk of provider.streamChat(request)) {
      if (chunk.reasoningContent) reasoningContent += chunk.reasoningContent;
      if (chunk.content) content += chunk.content;
      if (chunk.finishReason) finishReason = chunk.finishReason;
      if (chunk.usage) providerUsage = chunk.usage;
    }

    return {
      id: `stream_${Date.now()}`,
      model: request.model.modelId,
      content,
      reasoningContent: reasoningContent || undefined,
      finishReason,
      usage: buildStreamUsage(
        providerUsage,
        estimateInputTokens(request.messages),
        content,
        reasoningContent,
        request.model.costPer1K,
      ),
      latencyMs: Date.now() - startTime,
    };
  }

  /**
   * True streaming (AsyncIterable) for HTTP-layer SSE forwarding. NOT wrapped
   * in callWithRetry - mid-stream retry would duplicate generated tokens, so it
   * is the caller's (HTTP layer's) responsibility to handle stream errors.
   *
   * 这条路径**不经 `chat()`**（tutoring 与 admin-chat 直接调它做 SSE 转发），
   * 所以账本必须在这里也记一笔。做法是原样透传每个 chunk（**不改变任何 SSE 行为**），
   * 同时在边上累积 content/reasoning，结束时按同一套 `buildStreamUsage` 估算后落一行。
   *
   * 三点必须注意：
   *   1. 本路径**不走 callWithRetry**（中途重试会重复吐 token），故 `attempt` 恒为 1。
   *   2. 客户端中途断开时，生成器会被 `.return()`，`finally` 仍会执行 —— 这是对的：
   *      token 已经烧掉了，必须记账（失败原因记 AbortError）。
   *   3. `provider.streamChat` 是 async generator，`this` 在嵌套函数里不自动绑定，
   *      故先 `const self = this`。
   */
  streamChat(request: ChatRequest): AsyncIterable<StreamChunk> {
    const provider = this.getProvider(request.model.provider, request.model.apiKey);
    const self = this;
    return (async function* (): AsyncIterable<StreamChunk> {
      const started = Date.now();
      let content = '';
      let reasoningContent = '';
      let providerUsage: { inputTokens: number; outputTokens: number } | null = null;
      let failed: unknown = null;
      try {
        for await (const chunk of provider.streamChat(request)) {
          if (chunk.content) content += chunk.content;
          if (chunk.reasoningContent) reasoningContent += chunk.reasoningContent;
          if (chunk.usage) providerUsage = chunk.usage;
          yield chunk; // 原样透传，SSE 行为零变化
        }
      } catch (err) {
        failed = err;
        throw err;
      } finally {
        self.recordCall(
          request,
          1,
          true,
          failed === null
            ? buildStreamUsage(
                providerUsage,
                estimateInputTokens(request.messages),
                content,
                reasoningContent,
                request.model.costPer1K,
              )
            : null,
          Date.now() - started,
          failed,
        );
      }
    })();
  }
}
