import { describe, it, expect } from 'vitest';
import { LocalClient } from './local-client.js';
import { KimiClient } from './kimi-client.js';

const request = {
  model: {
    provider: 'local' as const, modelId: 'Qwen3.8-27B', baseUrl: 'http://192.168.1.8:12345',
    apiKey: 'local', contextWindow: 32768, maxOutputTokens: 4096,
    costPer1K: { input: 0, output: 0 }, supportsStreaming: true,
  },
  messages: [{ role: 'user' as const, content: 'hi' }],
  responseFormat: 'json_object' as const,
};

describe('LocalClient', () => {
  it('请求体不下发 enable_thinking（llama.cpp 非 DashScope 端点）', () => {
    const body = (new LocalClient('local') as any).buildRequestBody(request, false);
    expect(body.enable_thinking).toBeUndefined();
  });

  it('保留 response_format: json_object（判题 JSON 依赖）', () => {
    const body = (new LocalClient('local') as any).buildRequestBody(request, false);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('云端 OpenAI 兼容客户端仍下发 enable_thinking（行为不变）', () => {
    const body = (new KimiClient('sk-x') as any).buildRequestBody(request, false);
    expect(body.enable_thinking).toBe(true);
  });
});
