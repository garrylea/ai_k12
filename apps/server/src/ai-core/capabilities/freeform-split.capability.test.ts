import { describe, it, expect, vi } from 'vitest';
import { FreeformSplitCapability } from './freeform-split.capability.js';

const router = {
  route: vi.fn().mockReturnValue({
    primary: { modelId: 'Qwen3.8-27B', modelKey: 'local' },
    fallback: { modelId: 'qwen3.8-max', modelKey: 'qwen3.8-max' },
  }),
} as any;

function clientReturning(content: string) {
  return { chat: vi.fn().mockResolvedValue({ content }) } as any;
}

/** 每个用例独立的 router mock，避免调用次数/参数断言互相污染。 */
function freshRouter() {
  return {
    route: vi.fn().mockReturnValue({
      primary: { modelId: 'Qwen3.8-27B', modelKey: 'local' },
      fallback: { modelId: 'qwen3.8-max', modelKey: 'qwen3.8-max' },
    }),
  } as any;
}

const userMessageOf = (chat: ReturnType<typeof vi.fn>): string => {
  const messages = chat.mock.calls[0][0].messages as Array<{ role: string; content: string }>;
  const user = messages.find(m => m.role === 'user');
  expect(user).toBeDefined();
  return user!.content;
};

describe('FreeformSplitCapability', () => {
  it('解析候选题 JSON', async () => {
    const content = JSON.stringify({
      questions: [{
        no: '5', content: '已知 ![图](images/a.jpg) 求 x', figureRefs: ['images/a.jpg'],
        suggestedSubject: 'math', confidence: 0.9, selectedHint: true,
      }],
    });
    const cap = new FreeformSplitCapability({ modelRouter: router, modelClient: clientReturning(content) });
    const out = await cap.split({ markdown: '<!-- page 1 -->\n第5题...', textHint: '第5题' });
    expect(out).toHaveLength(1);
    expect(out[0].figureRefs).toEqual(['images/a.jpg']);
    expect(out[0].selectedHint).toBe(true);
  });

  it('本地 JSON 坏 → 回退千问', async () => {
    const client = {
      chat: vi.fn()
        .mockResolvedValueOnce({ content: '不是 json' })
        .mockResolvedValueOnce({ content: JSON.stringify({ questions: [{ content: '题', no: '1' }] }) }),
    } as any;
    const cap = new FreeformSplitCapability({ modelRouter: router, modelClient: client });
    const out = await cap.split({ markdown: '题' });
    expect(out[0].content).toBe('题');
    expect(client.chat).toHaveBeenCalledTimes(2);
  });

  it('两路都失败抛错', async () => {
    const client = { chat: vi.fn().mockResolvedValue({ content: 'not json' }) } as any;
    const cap = new FreeformSplitCapability({ modelRouter: router, modelClient: client });
    await expect(cap.split({ markdown: '题' })).rejects.toThrow(/freeform split failed/i);
  });

  it('未指定学科时提示词不声称数学，但路由仍用 math', async () => {
    const route = freshRouter();
    const client = clientReturning(JSON.stringify({ questions: [{ content: '题' }] }));
    const cap = new FreeformSplitCapability({ modelRouter: route, modelClient: client });

    await cap.split({ markdown: '第5题 求 x' });

    const user = userMessageOf(client.chat);
    expect(user).not.toContain('学科建议：math');
    expect(user).toMatch(/学科建议（为空表示未指定/);
    // 路由仍需要一个 subject 才能选场景模型。
    expect(route.route).toHaveBeenCalledWith(expect.objectContaining({ subject: 'math' }));
  });

  it('单题字段失范（题号数字 / 置信度越界 / 学科乱写）不废掉整批', async () => {
    const content = JSON.stringify({
      questions: [{
        no: 5,
        content: '求 x',
        figureRefs: 'images/a.jpg',
        suggestedSubject: 'math | physics | chemistry | null',
        confidence: 1.2,
      }],
    });
    const cap = new FreeformSplitCapability({ modelRouter: freshRouter(), modelClient: clientReturning(content) });

    const out = await cap.split({ markdown: '第5题' });

    expect(out).toHaveLength(1);
    expect(out[0].no).toBe('5');
    expect(typeof out[0].no).toBe('string');
    expect(out[0].confidence).toBe(1);
    expect(out[0].suggestedSubject).toBeNull();
    expect(out[0].figureRefs).toEqual([]);
  });

  it('preferFallback: 跳过本地，只调千问且全文进提示词（不截断）', async () => {
    const route = freshRouter();
    const client = clientReturning(JSON.stringify({ questions: [{ content: '题' }] }));
    const cap = new FreeformSplitCapability({ modelRouter: route, modelClient: client });
    const markdown = `${'题'.repeat(25000)}尾部标记`;

    await cap.split({ markdown, preferFallback: true });

    expect(client.chat).toHaveBeenCalledTimes(1);
    expect(client.chat.mock.calls[0][0].model).toEqual({
      modelId: 'qwen3.8-max',
      modelKey: 'qwen3.8-max',
    });
    const user = userMessageOf(client.chat);
    expect(user).toContain('尾部标记');
    expect(user.length).toBeGreaterThan(25000);
  });

  it('注入的 Markdown 原样进入 user message（含 ## 标题与图片引用）', async () => {
    const client = clientReturning(JSON.stringify({ questions: [{ content: '题' }] }));
    const cap = new FreeformSplitCapability({ modelRouter: freshRouter(), modelClient: client });
    const markdown = '## 一、选择题\n第5题 如图 ![](images/a.jpg) 求 x 的值。';

    await cap.split({ markdown, textHint: '第5题' });

    const user = userMessageOf(client.chat);
    expect(user).toContain('## 一、选择题');
    expect(user).toContain('![](images/a.jpg)');
    expect(user).toContain('求 x 的值。');
  });
});
