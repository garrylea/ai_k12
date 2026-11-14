import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FreeformTagCapability } from './freeform-tag.capability';

const chat = vi.fn();

beforeEach(() => chat.mockReset());

describe('FreeformTagCapability', () => {
  it('只保留候选清单内的知识点 id，去重并最多 3 个', async () => {
    chat.mockResolvedValue({
      content: JSON.stringify({
        type: 'short_answer',
        difficulty: 2,
        answer: 'x=1',
        explanation: '移项',
        approach: '移项求解',
        options: null,
        knowledgePointIds: [11, 99, 12, 13, 11],
        confidence: 'high',
      }),
    });
    const cap = new FreeformTagCapability({ modelClient: { chat } as any });
    const r = await cap.tag({
      question: '解方程 x+1=2',
      subjectId: 1,
      subjectName: '数学',
      gradeBand: 'junior',
      knowledgePointOptions: [
        { id: 11, name: '一元一次方程' },
        { id: 12, name: '移项' },
        { id: 13, name: '解方程' },
      ],
    });
    expect(r.knowledgePointIds).toEqual([11, 12, 13]);
    expect(r.answer).toBe('x=1');
  });

  it('模型返回坏 JSON 时降级为低置信度空结果', async () => {
    chat.mockResolvedValue({ content: 'not json' });
    const cap = new FreeformTagCapability({ modelClient: { chat } as any });
    const r = await cap.tag({
      question: '题',
      subjectId: 1,
      subjectName: '数学',
      gradeBand: 'junior',
      knowledgePointOptions: [],
    });
    expect(r.knowledgePointIds).toEqual([]);
    expect(r.answer).toBe('');
    expect(r.confidence).toBe('low');
  });
});
