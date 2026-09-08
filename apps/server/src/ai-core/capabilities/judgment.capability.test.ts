import { describe, it, expect, vi } from 'vitest';
import { JudgmentCapability } from './judgment.capability.js';
import type { ModelClient } from '../infra/model-client/index.js';

const mockChat = vi.fn();
const mockModelClient = { chat: mockChat } as unknown as ModelClient;

describe('JudgmentCapability', () => {
  it('答错返回 isCorrect=false + errorType（不再生成 analysis）', async () => {
    mockChat.mockResolvedValueOnce({
      content: '{"isCorrect":false,"errorType":"calculation"}',
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
    expect(r.analysis ?? null).toBeNull();
    expect(r.errorType).toBe('calculation');
  });

  it('答对返回 isCorrect=true', async () => {
    mockChat.mockResolvedValueOnce({
      content: '{"isCorrect":true,"errorType":null}',
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
