import { describe, it, expect, vi } from 'vitest';
import { ModelClient } from './index.js';
import { RateLimitError, AuthenticationError, ServerError, LLMClientError } from '../../types.js';
import type { ChatResponse, StreamChunk, ModelConfig, ErrorContext } from '../../types.js';
import type { ProviderAdapter } from './types.js';

const kimiModel: ModelConfig = {
  modelId: 'kimi-latest',
  provider: 'kimi',
  baseUrl: 'https://example.test',
  contextWindow: 131072,
  maxOutputTokens: 16384,
  costPer1K: { input: 0.012, output: 0.012 },
  supportsStreaming: true,
};

const noRetry = { maxRetries: 0, baseDelayMs: 0, maxBackoffMs: 0 };

function ctx(status = 500): ErrorContext {
  return { provider: 'kimi', statusCode: status, providerCode: null, retryAfterMs: null, hint: 'test', modelId: 'kimi-latest', retryable: true };
}

/** Build a mock provider whose streamChat yields chunks (or throws on every iteration). */
function makeProvider(opts: { chunks?: StreamChunk[]; streamError?: LLMClientError; chatResponse?: ChatResponse }): ProviderAdapter {
  const iterable: AsyncIterable<StreamChunk> = {
    async *[Symbol.asyncIterator]() {
      if (opts.streamError) throw opts.streamError;
      for (const c of opts.chunks ?? []) yield c;
    },
  };
  return {
    chat: vi.fn(async () => opts.chatResponse ?? {
      id: 'r1', model: 'kimi-latest', content: 'chat-ok', finishReason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 1, cost: 0 }, latencyMs: 0,
    }),
    streamChat: vi.fn(() => iterable),
  };
}

function withProvider(provider: ProviderAdapter, retryOptions = noRetry): ModelClient {
  return new ModelClient({ retryOptions, providers: new Map([['kimi', provider]]) });
}

describe('ModelClient', () => {
  it('chat() defaults to streaming: aggregates content + reasoningContent', async () => {
    const provider = makeProvider({
      chunks: [
        { content: '', reasoningContent: 'thinking...' },
        { content: 'hello' },
        { content: '', finishReason: 'stop' },
      ],
    });
    const res = await withProvider(provider).chat({ model: kimiModel, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toBe('hello');
    expect(res.reasoningContent).toBe('thinking...');
    expect(res.finishReason).toBe('stop');
    expect(provider.chat).not.toHaveBeenCalled();
    expect(provider.streamChat).toHaveBeenCalled();
  });

  it('chat() stream=false falls back to non-streaming provider.chat', async () => {
    const provider = makeProvider({
      chatResponse: { id: 'r1', model: 'kimi-latest', content: 'chat-ok', reasoningContent: 'reason', finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 3, cost: 0.01 }, latencyMs: 0 },
    });
    const res = await withProvider(provider).chat({ model: kimiModel, messages: [{ role: 'user', content: 'hi' }], stream: false });
    expect(res.content).toBe('chat-ok');
    expect(res.reasoningContent).toBe('reason');
    expect(provider.chat).toHaveBeenCalled();
  });

  it('chat() retries a retryable ServerError then succeeds', async () => {
    let calls = 0;
    const provider: ProviderAdapter = {
      chat: vi.fn(),
      streamChat: vi.fn((): AsyncIterable<StreamChunk> => ({
        async *[Symbol.asyncIterator]() {
          calls++;
          if (calls === 1) throw new ServerError(ctx(500));
          yield { content: 'recovered' };
        },
      })),
    };
    const res = await withProvider(provider, { maxRetries: 2, baseDelayMs: 1, maxBackoffMs: 1 })
      .chat({ model: kimiModel, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toBe('recovered');
  });

  it('chat() throws after exhausting retries on a retryable error', async () => {
    const provider = makeProvider({ streamError: new ServerError(ctx(500)) });
    await expect(withProvider(provider, { maxRetries: 1, baseDelayMs: 1, maxBackoffMs: 1 })
      .chat({ model: kimiModel, messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow();
  });

  it('chat() does NOT retry non-retryable AuthenticationError', async () => {
    const provider = makeProvider({ streamError: new AuthenticationError(ctx(401)) });
    await expect(withProvider(provider, { maxRetries: 3, baseDelayMs: 1, maxBackoffMs: 1 })
      .chat({ model: kimiModel, messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow();
    expect(provider.streamChat).toHaveBeenCalledTimes(1);
  });

  it('chat() preserves the provider error type (429 -> RateLimitError)', async () => {
    const provider = makeProvider({ streamError: new RateLimitError(ctx(429)) });
    await expect(withProvider(provider)
      .chat({ model: kimiModel, messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(RateLimitError);
  });
});
