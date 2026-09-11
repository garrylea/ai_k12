import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAICompatibleClient } from './openai-compatible-client.js';
import { TimeoutError } from '../../types.js';

// Small idle windows so the stall/reset tests run fast. The mocked module
// replaces the retry.yaml-loaded config for this file only.
vi.mock('../../config.js', () => ({
  timeoutConfig: {
    retry: { maxRetries: 0, baseDelayMs: 1, maxBackoffMs: 1 },
    timeout: {},
    streaming: { firstTokenTimeoutMs: 30, interTokenTimeoutMs: 30 },
  },
}));

const request = {
  model: {
    provider: 'kimi' as const, modelId: 'kimi-latest', baseUrl: 'https://api.moonshot.cn',
    apiKey: 'sk-x', contextWindow: 8, maxOutputTokens: 8,
    costPer1K: { input: 0, output: 0 }, supportsStreaming: true,
  },
  messages: [{ role: 'user' as const, content: 'hi' }],
  responseFormat: 'json_object' as const,
  stopSequences: ['END'],
};

describe('OpenAICompatibleClient.buildRequestBody', () => {
  it('非流式请求体含 enable_thinking 与 response_format，不含 stream', () => {
    const body = (new OpenAICompatibleClient('sk-x') as any).buildRequestBody(request, false);
    expect(body.enable_thinking).toBe(true);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.stream).toBeUndefined();
    expect(body.stop).toEqual(['END']);
  });

  it('流式请求体带 stream: true', () => {
    const body = (new OpenAICompatibleClient('sk-x') as any).buildRequestBody(request, true);
    expect(body.stream).toBe(true);
    expect(body.stop).toBeUndefined();
  });

  it('thinking:false 时下发 enable_thinking:false', () => {
    const body = (new OpenAICompatibleClient('sk-x') as any).buildRequestBody({ ...request, thinking: false }, false);
    expect(body.enable_thinking).toBe(false);
  });

  it('不传 thinking 时仍下发 enable_thinking:true（默认行为不变）', () => {
    const body = (new OpenAICompatibleClient('sk-x') as any).buildRequestBody(request, false);
    expect(body.enable_thinking).toBe(true);
  });
});

describe('OpenAICompatibleClient.streamChat idle timeout', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { globalThis.fetch = originalFetch; });

  // A fake upstream stream whose read() rejects only when the request signal
  // aborts - mirrors how a real fetch body behaves.
  function stalledResponse(init?: RequestInit): Response {
    return new Response(new ReadableStream({
      start(controller) {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener('abort', () => {
          controller.error(new DOMException('Aborted', 'AbortError'));
        });
      },
    }), { status: 200 });
  }

  it('空闲超时抛 TimeoutError（不再落成通用 5000）', async () => {
    globalThis.fetch = vi.fn((_url: string, init?: RequestInit) =>
      Promise.resolve(stalledResponse(init))) as unknown as typeof fetch;

    const client = new OpenAICompatibleClient('sk-x');
    const iter = client.streamChat(request as any)[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toBeInstanceOf(TimeoutError);
  });

  it('用户主动停止仍抛 AbortError（保持停止语义）', async () => {
    globalThis.fetch = vi.fn((_url: string, init?: RequestInit) =>
      Promise.resolve(stalledResponse(init))) as unknown as typeof fetch;

    const ac = new AbortController();
    const client = new OpenAICompatibleClient('sk-x');
    const iter = client.streamChat({ ...request, signal: ac.signal } as any)[Symbol.asyncIterator]();
    const pending = iter.next();
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('持续有数据返回则不超时（每次收到数据都会重置计时器）', async () => {
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'a' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'b' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ];
    let i = 0;
    globalThis.fetch = vi.fn(async () => new Response(new ReadableStream({
      async pull(controller) {
        if (i >= chunks.length) { controller.close(); return; }
        // 15ms < 30ms idle window -> each chunk re-arms the deadline.
        await new Promise((r) => setTimeout(r, 15));
        controller.enqueue(new TextEncoder().encode(chunks[i++]));
      },
    }), { status: 200 })) as unknown as typeof fetch;

    const client = new OpenAICompatibleClient('sk-x');
    const out: string[] = [];
    for await (const c of client.streamChat(request as any)) {
      if (c.reasoningContent) out.push(c.reasoningContent);
    }
    expect(out).toEqual(['a', 'b']);
  });
});
