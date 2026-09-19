import type { ChatRequest, ChatResponse, ChatMessage, StreamChunk, RetryOptions } from '../../types.js';
import { contentToText } from '../../types.js';
import { timeoutConfig, getApiKeyByProvider } from '../../config.js';
import type { ProviderAdapter } from './types.js';
import { callWithRetry } from './errors.js';
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
   */
  streamChat(request: ChatRequest): AsyncIterable<StreamChunk> {
    const provider = this.getProvider(request.model.provider, request.model.apiKey);
    return provider.streamChat(request);
  }
}
