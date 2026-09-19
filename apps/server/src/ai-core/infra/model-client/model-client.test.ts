import { describe, it, expect, vi, afterEach } from 'vitest';
import { ModelClient } from './index';
import { setLlmCallSink } from '../llm-call-log';
import { runWithRequestContext } from '../request-context';

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

describe('ModelClient 写 llm_call_logs', () => {
  afterEach(() => setLlmCallSink(null));

  const baseModel = (extra: Record<string, unknown> = {}) => ({
    provider: 'kimi', modelId: 'kimi-latest', baseUrl: 'https://x', contextWindow: 8,
    maxOutputTokens: 8, supportsStreaming: true, costPer1K: { input: 0.012, output: 0.012 }, ...extra,
  });

  it('成功调用记一条：带 scene/attempt/cost，usage 来自响应', async () => {
    const entries: any[] = [];
    setLlmCallSink((e) => entries.push(e));
    const providers = new Map([
      ['kimi', {
        chat: vi.fn().mockResolvedValue({
          id: 'r1', model: 'kimi-latest', content: 'ok', finishReason: 'stop',
          usage: { inputTokens: 100, outputTokens: 20, cost: 0.0012, source: 'provider' }, latencyMs: 5,
        }),
        streamChat: async function* () {},
      }],
    ]);
    const mc = new ModelClient({ providers } as any);
    await mc.chat({
      model: baseModel({ scene: 'judgment', subject: 'math', modelKey: 'kimi' }) as any,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      meta: { studentId: 9, capability: 'judgment' },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      studentId: 9, scene: 'judgment', subject: 'math', modelKey: 'kimi', provider: 'kimi',
      attempt: 1, requestKind: 'chat', isFallback: false, success: true,
      inputTokens: 100, outputTokens: 20, usageSource: 'provider',
    });
  });

  it('失败也记一条：success=false，cost 为 null', async () => {
    const entries: any[] = [];
    setLlmCallSink((e) => entries.push(e));
    const boom = Object.assign(new Error('nope'), { name: 'ServerError', statusCode: 500 });
    const providers = new Map([
      ['kimi', { chat: vi.fn().mockRejectedValue(boom), streamChat: async function* () {} }],
    ]);
    const mc = new ModelClient({ providers, retryOptions: { maxRetries: 0, baseDelayMs: 1, maxBackoffMs: 1 } } as any);
    await expect(mc.chat({
      model: baseModel() as any,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })).rejects.toThrow();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ success: false, inputTokens: null, outputTokens: null, usageSource: 'unavailable' });
  });

  it('没注册 sink 时调用照常成功（埋点缺席不能影响业务）', async () => {
    setLlmCallSink(null);
    const providers = new Map([
      ['kimi', { chat: vi.fn().mockResolvedValue({ content: 'ok', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, cost: 0 }, model: 'm', id: 'i', latencyMs: 1 }), streamChat: async function* () {} }],
    ]);
    const mc = new ModelClient({ providers } as any);
    const res = await mc.chat({ model: baseModel() as any, messages: [{ role: 'user', content: 'hi' }], stream: false });
    expect(res.content).toBe('ok');
  });

  // ★ 这一条钉住 8d：真流式路径（tutoring / admin-chat 直接调 streamChat）也必须落账本。
  // 少了它，AI 讨论/答疑在账本里会完全缺席，而那是 token 消耗最大的场景。
  it('streamChat 消费完毕后落一条账本（requestKind=stream，attempt=1），且 chunk 原样透传', async () => {
    const entries: any[] = [];
    setLlmCallSink((e) => entries.push(e));
    const providers = new Map([
      ['kimi', {
        chat: vi.fn(),
        streamChat: async function* () {
          yield { content: 'abcdefgh' };           // 输出 2 token
          yield { content: '', reasoningContent: '你好世界' }; // 输出再 +4
        },
      }],
    ]);
    const mc = new ModelClient({ providers } as any);
    const seen: string[] = [];
    for await (const c of mc.streamChat({
      model: baseModel({ scene: 'tutoring', subject: 'math', modelKey: 'kimi' }) as any,
      messages: [{ role: 'user', content: '你好' }],  // 输入 2 token
      meta: { studentId: 7, capability: 'tutoring' },
    } as any)) {
      // 收集**全部** chunk（含 content 为空、只带 reasoning 的那个），
      // 否则「原样透传」的断言会被过滤条件掩盖成假绿。
      seen.push(c.content);
    }
    // chunk 必须原样透传（SSE 行为不能变）
    expect(seen).toEqual(['abcdefgh', '']);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      studentId: 7, scene: 'tutoring', subject: 'math', modelKey: 'kimi',
      attempt: 1, requestKind: 'stream', success: true, usageSource: 'estimated',
      inputTokens: 2, outputTokens: 6,
    });
  });

  it('meta 显式给 studentId: null 表示「明确不归属」，压住 ALS 兜底', async () => {
    const entries: any[] = [];
    setLlmCallSink((e) => entries.push(e));
    const providers = new Map([
      ['kimi', { chat: vi.fn().mockResolvedValue({ content: 'ok', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, cost: 0 }, model: 'm', id: 'i', latencyMs: 1 }), streamChat: async function* () {} }],
    ]);
    const mc = new ModelClient({ providers } as any);
    await runWithRequestContext({ requestId: 'r', studentId: 9, role: 'student' }, async () => {
      await mc.chat({
        model: baseModel() as any,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        meta: { studentId: null, capability: 'explanation' }, // 题目级缓存：不属任何学生
      });
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].studentId).toBeNull(); // 关键：不能变成 9
  });

  // request_id 是 api_request_logs 的 join 键，而那张表的 student_id 是真实学生。
  // 显式「不归属」若仍带上下文里的 request_id，将来 join 会把它重新算到那个学生头上。
  it('显式 studentId: null 时连带清空 requestId，避免 join 重新归属', async () => {
    const entries: any[] = [];
    setLlmCallSink((e) => entries.push(e));
    const providers = new Map([
      ['kimi', { chat: vi.fn().mockResolvedValue({ content: 'ok', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, cost: 0 }, model: 'm', id: 'i', latencyMs: 1 }), streamChat: async function* () {} }],
    ]);
    const mc = new ModelClient({ providers } as any);
    await runWithRequestContext({ requestId: 'r-ambient', studentId: 9, role: 'student' }, async () => {
      await mc.chat({
        model: baseModel() as any,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        meta: { studentId: null, capability: 'explanation' }, // 题目级缓存：不属任何学生
      });
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].studentId).toBeNull();
    expect(entries[0].requestId).toBeNull(); // 关键：不能变成 'r-ambient'
  });

  it('meta 不给 studentId 时仍走 ALS 归属', async () => {
    const entries: any[] = [];
    setLlmCallSink((e) => entries.push(e));
    const providers = new Map([
      ['kimi', { chat: vi.fn().mockResolvedValue({ content: 'ok', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, cost: 0 }, model: 'm', id: 'i', latencyMs: 1 }), streamChat: async function* () {} }],
    ]);
    const mc = new ModelClient({ providers } as any);
    await runWithRequestContext({ requestId: 'r-ambient', studentId: 9, role: 'student' }, async () => {
      await mc.chat({ model: baseModel() as any, messages: [{ role: 'user', content: 'hi' }], stream: false });
    });
    expect(entries[0].studentId).toBe(9);
    expect(entries[0].requestId).toBe('r-ambient'); // 抑制只限显式 null 那条路径
  });

  it('streamChat 中途失败也落一条（success=false），且异常原样抛出', async () => {
    const entries: any[] = [];
    setLlmCallSink((e) => entries.push(e));
    const providers = new Map([
      ['kimi', {
        chat: vi.fn(),
        streamChat: async function* () {
          yield { content: '部分内容' };
          throw Object.assign(new Error('boom'), { name: 'ServerError' });
        },
      }],
    ]);
    const mc = new ModelClient({ providers } as any);
    await expect((async () => {
      for await (const _ of mc.streamChat({ model: baseModel() as any, messages: [{ role: 'user', content: 'hi' }] } as any)) { /* drain */ }
    })()).rejects.toThrow('boom');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ requestKind: 'stream', success: false, inputTokens: null, outputTokens: null, errorType: 'ServerError' });
  });
});
