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
