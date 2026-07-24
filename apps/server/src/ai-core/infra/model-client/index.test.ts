import { describe, it, expect, vi, afterEach } from 'vitest';
import { ModelClient } from './index.js';
import { ModelClientError, ModelErrorCode } from '../../types.js';
import type { ModelConfig } from '../../types.js';

const kimiModel: ModelConfig = {
  modelId: 'kimi-latest',
  provider: 'kimi',
  baseUrl: 'https://example.test',
  contextWindow: 131072,
  maxOutputTokens: 16384,
  costPer1K: { input: 0.012, output: 0.012 },
  supportsStreaming: true,
};

function okResponse(content: string, promptTokens = 10, completionTokens = 5): Response {
  return new Response(JSON.stringify({
    id: 'resp_1',
    model: 'kimi-latest',
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function errResponse(status = 500): Response {
  return new Response('server error', { status });
}

describe('ModelClient', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  // Mirrors retry.yaml: only transient errors are retried.
  const retryable = [ModelErrorCode.RATE_LIMITED, ModelErrorCode.SERVICE_UNAVAILABLE, ModelErrorCode.TIMEOUT];

  it('chat() returns parsed response with latencyMs and cost', async () => {
    const fetchMock = vi.fn(async () => okResponse('hello'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new ModelClient({ retryConfig: { maxRetries: 0, initialDelayMs: 0, backoffMultiplier: 1, retryableCodes: retryable } });
    const res = await client.chat({ model: kimiModel, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toBe('hello');
    expect(res.finishReason).toBe('stop');
    expect(res.usage.inputTokens).toBe(10);
    expect(res.usage.outputTokens).toBe(5);
    expect(res.usage.cost).toBeGreaterThan(0);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('chat() retries on a retryable 500 then succeeds', async () => {
    const fetchMock = vi.fn(async () => errResponse(500))
      .mockResolvedValueOnce(errResponse(500))
      .mockResolvedValueOnce(okResponse('recovered'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new ModelClient({ retryConfig: { maxRetries: 2, initialDelayMs: 1, backoffMultiplier: 1, retryableCodes: retryable } });
    const res = await client.chat({ model: kimiModel, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('chat() throws after exhausting retries on a retryable error', async () => {
    const fetchMock = vi.fn(async () => errResponse(500));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new ModelClient({ retryConfig: { maxRetries: 1, initialDelayMs: 1, backoffMultiplier: 1, retryableCodes: retryable } });
    await expect(client.chat({ model: kimiModel, messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('chat() does NOT retry non-retryable errors (401 -> QUOTA_EXCEEDED)', async () => {
    const fetchMock = vi.fn(async () => errResponse(401));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new ModelClient({ retryConfig: { maxRetries: 3, initialDelayMs: 1, backoffMultiplier: 1, retryableCodes: retryable } });
    await expect(client.chat({ model: kimiModel, messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('chat() preserves the provider error code (429 -> RATE_LIMITED)', async () => {
    const fetchMock = vi.fn(async () => errResponse(429));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new ModelClient({ retryConfig: { maxRetries: 0, initialDelayMs: 0, backoffMultiplier: 1, retryableCodes: retryable } });
    try {
      await client.chat({ model: kimiModel, messages: [{ role: 'user', content: 'hi' }] });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ModelClientError);
      expect((e as ModelClientError).code).toBe(ModelErrorCode.RATE_LIMITED);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
