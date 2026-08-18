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
