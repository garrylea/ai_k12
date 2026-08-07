import { describe, it, expect, vi } from 'vitest';
import { JudgmentCapability } from './judgment.capability.js';
import type { ModelClient } from '../infra/model-client/index.js';

const mockChat = vi.fn();
const mockModelClient = { chat: mockChat } as unknown as ModelClient;

describe('JudgmentCapability', () => {
  it('答错返回 isCorrect=false + analysis', async () => {
    mockChat.mockResolvedValueOnce({
      content: '{"isCorrect":false,"analysis":"第二步错","errorType":"calculation"}',
      reasoningContent: '',
    });
    const cap = new JudgmentCapability({ modelClient: mockModelClient });
    const r = await cap.judge({
      questionContent: '解方程 $x^2-4=0$',
      standardAnswer: '$x=\\pm 2$',
      reference: '',
      studentAnswer: '$x=2$',
      subject: 'math',
      questionType: 'calculation',
    });
    expect(r.isCorrect).toBe(false);
    expect(r.analysis).toBe('第二步错');
    expect(r.errorType).toBe('calculation');
  });

  it('答对返回 isCorrect=true', async () => {
    mockChat.mockResolvedValueOnce({
      content: '{"isCorrect":true,"analysis":"","errorType":null}',
      reasoningContent: '',
    });
    const r = await new JudgmentCapability({ modelClient: mockModelClient }).judge({
      questionContent: 'q',
      standardAnswer: 'a',
      reference: '',
      studentAnswer: 'a',
      subject: 'math',
      questionType: 'calculation',
    });
    expect(r.isCorrect).toBe(true);
  });
});
