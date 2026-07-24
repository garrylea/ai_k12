import type { ChatRequest, ChatResponse, StreamChunk, RetryConfig } from '../../types.js';
import { ModelClientError, ModelErrorCode } from '../../types.js';
import { timeoutConfig, getApiKeyByProvider } from '../../config.js';
import type { ProviderAdapter } from './types.js';
import { KimiClient } from './kimi-client.js';
import { QwenClient } from './qwen-client.js';
import { DeepSeekClient } from './deepseek-client.js';
import { GeminiClient } from './gemini-client.js';

export class ModelClient {
  private providers = new Map<string, ProviderAdapter>();
  private retryConfig: RetryConfig;
  private providerOverrides?: Map<string, ProviderAdapter>;

  constructor(opts?: { retryConfig?: RetryConfig; providers?: Map<string, ProviderAdapter> }) {
    this.retryConfig = opts?.retryConfig ?? {
      maxRetries: timeoutConfig.retry.maxRetries,
      initialDelayMs: timeoutConfig.retry.initialDelayMs,
      backoffMultiplier: timeoutConfig.retry.backoffMultiplier,
      retryableCodes: timeoutConfig.retry.retryableCodes,
    };
    this.providerOverrides = opts?.providers;
  }

  private getProvider(provider: string): ProviderAdapter {
    if (this.providers.has(provider)) return this.providers.get(provider)!;

    let client: ProviderAdapter;
    if (this.providerOverrides?.has(provider)) {
      client = this.providerOverrides.get(provider)!;
    } else {
      const apiKey = getApiKeyByProvider(provider);
      switch (provider) {
        case 'kimi': client = new KimiClient(apiKey); break;
        case 'qwen': client = new QwenClient(apiKey); break;
        case 'deepseek': client = new DeepSeekClient(apiKey); break;
        case 'gemini': client = new GeminiClient(apiKey); break;
        default: throw new Error(`Unknown provider: ${provider}`);
      }
    }
    this.providers.set(provider, client);
    return client;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const provider = this.getProvider(request.model.provider);
    const startTime = Date.now();

    let lastError: ModelClientError | null = null;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        const response = await provider.chat(request);
        return { ...response, latencyMs: Date.now() - startTime };
      } catch (error) {
        lastError = this.classifyError(error, request.model.modelId);
        // Only retry errors whose code is in retryableCodes (e.g. RATE_LIMITED,
        // SERVICE_UNAVAILABLE, TIMEOUT). Non-retryable errors (QUOTA_EXCEEDED,
        // CONTENT_FILTERED, CONTEXT_TOO_LONG, UNKNOWN) throw immediately.
        const isRetryable = this.retryConfig.retryableCodes.includes(lastError.code);
        if (!isRetryable || attempt === this.retryConfig.maxRetries) {
          throw lastError;
        }
        const delay = this.retryConfig.initialDelayMs * Math.pow(this.retryConfig.backoffMultiplier, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError ?? new ModelClientError(ModelErrorCode.UNKNOWN, request.model.modelId, 'Max retries exceeded');
  }

  /**
   * Normalize a caught error into a ModelClientError, preserving the code when
   * the provider already threw one (mapHttpError), otherwise classifying fetch
   * network/timeout errors. retryable is derived from retryableCodes so the
   * config is the single source of truth.
   */
  private classifyError(error: unknown, modelId: string): ModelClientError {
    let code: ModelErrorCode;
    let message: string;
    if (error instanceof ModelClientError) {
      code = error.code;
      message = error.message;
    } else {
      message = error instanceof Error ? error.message : 'Unknown error';
      const isTimeout = error instanceof Error && (
        error.name === 'TimeoutError' || error.name === 'AbortError' || /timeout|abort/i.test(message)
      );
      code = isTimeout ? ModelErrorCode.TIMEOUT : ModelErrorCode.SERVICE_UNAVAILABLE;
    }
    const retryable = this.retryConfig.retryableCodes.includes(code);
    return new ModelClientError(code, modelId, message, retryable);
  }

  streamChat(request: ChatRequest): AsyncIterable<StreamChunk> {
    const provider = this.getProvider(request.model.provider);
    return provider.streamChat(request);
  }
}
