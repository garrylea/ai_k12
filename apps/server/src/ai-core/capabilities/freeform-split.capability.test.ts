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
});
