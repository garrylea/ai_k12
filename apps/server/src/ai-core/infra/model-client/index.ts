import type { ChatRequest, ChatResponse, StreamChunk, ModelErrorCode, RetryConfig } from '../../types.js';
import { ModelClientError } from '../../types.js';
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

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        const response = await provider.chat(request);
        return { ...response, latencyMs: Date.now() - startTime };
      } catch (error) {
        const isLastAttempt = attempt === this.retryConfig.maxRetries;
        if (isLastAttempt) {
          throw new ModelClientError(
            'UNKNOWN' as ModelErrorCode,
            request.model.modelId,
            error instanceof Error ? error.message : 'Unknown error',
            false,
          );
        }
        const delay = this.retryConfig.initialDelayMs * Math.pow(this.retryConfig.backoffMultiplier, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw new ModelClientError('UNKNOWN' as ModelErrorCode, request.model.modelId, 'Max retries exceeded');
  }

  streamChat(request: ChatRequest): AsyncIterable<StreamChunk> {
    const provider = this.getProvider(request.model.provider);
    return provider.streamChat(request);
  }
}
