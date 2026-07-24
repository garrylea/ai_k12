import { describe, it, expect, vi, afterEach } from 'vitest';
import { ModelClient } from './index.js';
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

  it('chat() returns parsed response with latencyMs and cost', async () => {
    const fetchMock = vi.fn(async () => okResponse('hello'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new ModelClient({ retryConfig: { maxRetries: 0, initialDelayMs: 0, backoffMultiplier: 1, retryableCodes: [] } });
    const res = await client.chat({ model: kimiModel, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toBe('hello');
    expect(res.finishReason).toBe('stop');
    expect(res.usage.inputTokens).toBe(10);
    expect(res.usage.outputTokens).toBe(5);
    expect(res.usage.cost).toBeGreaterThan(0);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('chat() retries on failure then succeeds', async () => {
    const fetchMock = vi.fn(async () => errResponse(500))
      .mockResolvedValueOnce(errResponse(500))
      .mockResolvedValueOnce(okResponse('recovered'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new ModelClient({ retryConfig: { maxRetries: 2, initialDelayMs: 1, backoffMultiplier: 1, retryableCodes: [] } });
    const res = await client.chat({ model: kimiModel, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('chat() throws after exhausting retries', async () => {
    const fetchMock = vi.fn(async () => errResponse(500));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new ModelClient({ retryConfig: { maxRetries: 1, initialDelayMs: 1, backoffMultiplier: 1, retryableCodes: [] } });
    await expect(client.chat({ model: kimiModel, messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
