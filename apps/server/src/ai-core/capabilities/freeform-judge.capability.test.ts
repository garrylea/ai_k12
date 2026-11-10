import { describe, it, expect, vi } from 'vitest';
import { FreeformJudgeCapability } from './freeform-judge.capability.js';

const judgeRoute = () =>
  ({
    route: vi.fn().mockReturnValue({ primary: { modelId: 'qwen3.8-max', modelKey: 'qwen3.8-max' } }),
  }) as any;

describe('FreeformJudgeCapability', () => {
  it('把 reasoning/content 原样流式吐出', async () => {
    const client = {
      streamChat: vi.fn().mockImplementation(async function* () {
        yield { reasoningContent: '先看题', content: '' };
        yield { content: '## 判题结果\n得分 7/10' };
      }),
    } as any;
    const router = judgeRoute();
    const cap = new FreeformJudgeCapability({ modelClient: client, modelRouter: router });
    const events: any[] = [];
    for await (const e of cap.stream({
      subject: 'math', maxScore: 10,
      questionContent: '已知 x+1=2', studentAnswer: 'x=1', images: [],
    })) events.push(e);

    expect(events[0]).toEqual({ type: 'reasoning', delta: '先看题' });
    expect(events[1]).toEqual({ type: 'content', delta: '## 判题结果\n得分 7/10' });
    // spec 固定场景与学科：scene 改名会静默落到默认路由（带 deepseek fallback）。
    expect(router.route).toHaveBeenCalledWith(
      expect.objectContaining({ scene: 'freeform_judge', subject: 'math' }),
    );
    const req = client.streamChat.mock.calls[0][0];
    expect(req.model.modelId).toBe('qwen3.8-max');
    expect(JSON.stringify(req.messages)).toContain('x+1=2');

    // 模板确实被渲染：满分进了 system 与 user 两段，学生作答进了 user。
    const messages = req.messages as Array<{ role: string; content: string }>;
    const system = messages.find(m => m.role === 'system')!.content;
    const user = messages.find(m => m.role === 'user')!.content;
    expect(system).toContain('满分固定为 10');
    expect(system).toContain('"verdict"');
    // 前端用 KaTeX：只认 $...$ / $$...$$，且示例必须包在 ```json 围栏里。
    expect(system).toContain('$...$');
    expect(system).toContain('尾部 JSON：\n```json');
    expect(user).toContain('满分：10');
    expect(user).toContain('x=1');
  });

  it('extractStructured 只返回 JSON 对象', async () => {
    const client = {
      chat: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          verdict: 'partial', totalScore: 7, maxScore: 10, steps: [], suggestions: [],
          question: { type: 'short_answer', difficulty: 1, options: null, answer: 'x=1', explanation: null, approach: null },
        }),
      }),
    } as any;
    const out = await new FreeformJudgeCapability({ modelClient: client, modelRouter: judgeRoute() })
      .extractStructured({ report: '报告', questionContent: '题', studentAnswer: '答', maxScore: 10 });
    expect((out as any).totalScore).toBe(7);

    // spec 固定的调用参数 + 无 fallback 契约（必须落在 qwen3.8-max 上）。
    expect(client.chat).toHaveBeenCalledWith(expect.objectContaining({
      responseFormat: 'json_object', thinking: false, timeout: 45000,
    }));
    expect(client.chat.mock.calls[0][0].model.modelId).toBe('qwen3.8-max');
  });

  it('图片按 label 逐个追加到最后一条 user 消息（text + image_url 部件）', async () => {
    const client = {
      streamChat: vi.fn().mockImplementation(async function* () {
        yield { content: 'ok' };
      }),
    } as any;
    const cap = new FreeformJudgeCapability({ modelClient: client, modelRouter: judgeRoute() });
    for await (const _ of cap.stream({
      subject: 'physics', maxScore: 10,
      questionContent: '题干', studentAnswer: '作答',
      images: [
        { label: '题目图', dataUrl: 'data:image/png;base64,AAA' },
        { label: '草稿图', dataUrl: 'data:image/png;base64,BBB' },
      ],
    })) { /* drain */ }

    const messages = client.streamChat.mock.calls[0][0].messages as Array<{ role: string; content: unknown }>;
    const last = messages[messages.length - 1];
    expect(last.role).toBe('user');
    expect(Array.isArray(last.content)).toBe(true);
    const parts = last.content as Array<any>;
    const texts = parts.filter(p => p.type === 'text').map(p => p.text).join('\n');
    expect(texts).toContain('题干');
    expect(texts).toContain('【题目图】');
    expect(texts).toContain('【草稿图】');
    expect(parts.filter(p => p.type === 'image_url').map(p => p.image_url.url))
      .toEqual(['data:image/png;base64,AAA', 'data:image/png;base64,BBB']);
  });

  it('未给图片时不改动消息内容（保持字符串）', async () => {
    const client = {
      streamChat: vi.fn().mockImplementation(async function* () {
        yield { content: 'ok' };
      }),
    } as any;
    const cap = new FreeformJudgeCapability({ modelClient: client, modelRouter: judgeRoute() });
    for await (const _ of cap.stream({
      subject: 'chemistry', maxScore: 5,
      questionContent: '题干', studentAnswer: '作答', images: [],
    })) { /* drain */ }

    const messages = client.streamChat.mock.calls[0][0].messages as Array<{ role: string; content: unknown }>;
    expect(typeof messages[messages.length - 1].content).toBe('string');
  });

  it('extractStructured 遇到非法 JSON 返回 null（不抛）', async () => {
    const client = { chat: vi.fn().mockResolvedValue({ content: 'not json' }) } as any;
    const out = await new FreeformJudgeCapability({ modelClient: client, modelRouter: judgeRoute() })
      .extractStructured({ report: '报告', questionContent: '题', studentAnswer: '答', maxScore: 10 });
    expect(out).toBeNull();
  });

  it('extractStructured 遇到非对象 JSON（字符串 / 数组）返回 null', async () => {
    const client = {
      chat: vi.fn()
        .mockResolvedValueOnce({ content: '"ok"' })
        .mockResolvedValueOnce({ content: '[]' }),
    } as any;
    const cap = new FreeformJudgeCapability({ modelClient: client, modelRouter: judgeRoute() });
    const req = { report: '报告', questionContent: '题', studentAnswer: '答', maxScore: 10 };
    expect(await cap.extractStructured(req)).toBeNull();
    expect(await cap.extractStructured(req)).toBeNull();
  });
});
