import type { ChatRequest, ChatResponse, StreamChunk, RetryOptions } from '../../types.js';
import { timeoutConfig, getApiKeyByProvider } from '../../config.js';
import type { ProviderAdapter } from './types.js';
import { callWithRetry } from './errors.js';
import { KimiClient } from './kimi-client.js';
import { QwenClient } from './qwen-client.js';
import { DeepSeekClient } from './deepseek-client.js';
import { GeminiClient } from './gemini-client.js';

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

    const run = async (): Promise<ChatResponse> => {
      if (useStream) {
        return this.aggregateStream(provider, request, startTime);
      }
      const response = await provider.chat(request);
      return { ...response, latencyMs: Date.now() - startTime };
    };

    return callWithRetry(run, this.retryOptions);
  }

  /**
   * Aggregate a provider's streamChat into a single ChatResponse. Collects
   * content + reasoningContent (thinking). usage is best-effort: 0 when the
   * provider's stream omits usage (e.g. Kimi - see ../kimi-chat.js note).
   */
  private async aggregateStream(provider: ProviderAdapter, request: ChatRequest, startTime: number): Promise<ChatResponse> {
    let content = '';
    let reasoningContent = '';
    let finishReason: ChatResponse['finishReason'] = 'stop';

    for await (const chunk of provider.streamChat(request)) {
      if (chunk.reasoningContent) reasoningContent += chunk.reasoningContent;
      if (chunk.content) content += chunk.content;
      if (chunk.finishReason) finishReason = chunk.finishReason;
    }

    return {
      id: `stream_${Date.now()}`,
      model: request.model.modelId,
      content,
      reasoningContent: reasoningContent || undefined,
      finishReason,
      usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
      latencyMs: Date.now() - startTime,
    };
  }

  /**
   * True streaming (AsyncIterable) for HTTP-layer SSE forwarding. NOT wrapped
   * in callWithRetry - mid-stream retry would duplicate generated tokens, so it
   * is the caller's (HTTP layer's) responsibility to handle stream errors.
   */
  streamChat(request: ChatRequest): AsyncIterable<StreamChunk> {
    const provider = this.getProvider(request.model.provider, request.model.apiKey);
    return provider.streamChat(request);
  }
}
