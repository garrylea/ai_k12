import { describe, it, expect, vi } from 'vitest';
import { ModelClient } from './index';

const okResponse = { content: 'ok', finishReason: 'stop' as const, usage: { promptTokens: 1, completionTokens: 1 } };

describe('ModelClient apiKey 优先级与缓存', () => {
  it('request.model.apiKey 优先；同 provider 不同 key 各自建 adapter 缓存', async () => {
    const providers = new Map([
      ['kimi', { chat: vi.fn().mockResolvedValue(okResponse), streamChat: async function* () {} }],
    ]);
    const mc = new ModelClient({ providers } as any);
    const req = (apiKey: string) => ({
      model: { provider: 'kimi', modelId: 'x', baseUrl: 'https://x', apiKey, contextWindow: 8, maxOutputTokens: 8, supportsStreaming: true },
      messages: [{ role: 'user' as const, content: 'hi' }],
      stream: false,
    });
    const r1 = await mc.chat(req('sk-a') as any);
    const r2 = await mc.chat(req('sk-b') as any);
    expect(r1.content).toBe('ok');
    expect(r2.content).toBe('ok');
  });

  it('同 provider 不同 apiKey 各自缓存条目；无 apiKey 时回落 provider-only key', () => {
    const mc = new ModelClient();
    const anyMc = mc as any;
    const a = anyMc.getProvider('kimi', 'sk-a');
    const b = anyMc.getProvider('kimi', 'sk-b');
    expect(anyMc.providers.get('kimi:sk-a')).toBe(a);
    expect(anyMc.providers.get('kimi:sk-b')).toBe(b);
    expect(a).not.toBe(b); // 同 provider 不同 key 各自实例化
    // 命中缓存：再次取同一 key 返回同一实例
    expect(anyMc.getProvider('kimi', 'sk-a')).toBe(a);
    // 无 apiKey 走 env 路径，缓存 key 为裸 provider 名
    const envClient = anyMc.getProvider('kimi');
    expect(anyMc.providers.get('kimi')).toBe(envClient);
    expect(envClient).not.toBe(a);
  });
});

describe('流式拿不到 usage 时的估算（输入/输出各自的数据源）', () => {
  it('输入估自请求 messages，输出估自响应正文', async () => {
    const providers = new Map([
      ['kimi', {
        chat: vi.fn(),
        streamChat: async function* () {
          yield { content: '你好世界' };      // 输出 4 token
        },
      }],
    ]);
    const mc = new ModelClient({ providers } as any);
    const res = await mc.chat({
      model: {
        provider: 'kimi', modelId: 'kimi-latest', baseUrl: 'https://x', contextWindow: 8,
        maxOutputTokens: 8, supportsStreaming: true, costPer1K: { input: 0.01, output: 0.02 },
      } as any,
      messages: [{ role: 'user', content: 'abcdefgh' }],   // 输入 2 token
      stream: true,
    });
    expect(res.usage.source).toBe('estimated');
    expect(res.usage.inputTokens).toBe(2);    // 来自请求
    expect(res.usage.outputTokens).toBe(4);   // 来自响应
    // cost 按两段分别计价：2/1000*0.01 + 4/1000*0.02 = 0.00002 + 0.00008
    expect(res.usage.cost).toBeCloseTo(0.0001, 8);
  });

  it('思考（reasoningContent）也计入输出 token —— 钉子用例', async () => {
    const providers = new Map([
      ['kimi', {
        chat: vi.fn(),
        streamChat: async function* () {
          yield { content: 'x' };                          // 输出 1 token（ceil(1/4)）
          yield { content: '', reasoningContent: '你好世界' }; // 输出 4 token（4 CJK）
        },
      }],
    ]);
    const mc = new ModelClient({ providers } as any);
    const res = await mc.chat({
      model: {
        provider: 'kimi', modelId: 'kimi-latest', baseUrl: 'https://x', contextWindow: 8,
        maxOutputTokens: 8, supportsStreaming: true, costPer1K: { input: 0.01, output: 0.02 },
      } as any,
      messages: [{ role: 'user', content: 'abcdefgh' }],   // 输入 2 token
      stream: true,
    });
    expect(res.usage.source).toBe('estimated');
    expect(res.usage.inputTokens).toBe(2);
    expect(res.usage.outputTokens).toBe(5);   // 1（'x'）+ 4（'你好世界'）
    expect(typeof res.usage.cost).toBe('number');
  });

  it('请求与响应都为空 -> unavailable，token/cost 全 NULL（不写 0）', async () => {
    const providers = new Map([
      ['kimi', { chat: vi.fn(), streamChat: async function* () { /* 什么都不 yield */ } }],
    ]);
    const mc = new ModelClient({ providers } as any);
    const res = await mc.chat({
      model: {
        provider: 'kimi', modelId: 'kimi-latest', baseUrl: 'https://x', contextWindow: 8,
        maxOutputTokens: 8, supportsStreaming: true, costPer1K: { input: 0.01, output: 0.02 },
      } as any,
      messages: [],
      stream: true,
    });
    expect(res.usage.source).toBe('unavailable');
    expect(res.usage.inputTokens).toBeNull();
    expect(res.usage.outputTokens).toBeNull();
    expect(res.usage.cost).toBeNull();
  });
});
