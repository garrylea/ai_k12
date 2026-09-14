import { describe, it, expect } from 'vitest';
import { HintCapability } from './hint.capability.js';
import { ModelClient } from '../infra/model-client/index.js';
import type { ChatResponse } from '../types.js';

describe('HintCapability', () => {
  it('constructs without error', () => {
    const capability = new HintCapability();
    expect(capability).toBeDefined();
  });

  it('loads hint/math.md template (system prompt enforces no-answer) and returns parsed content', async () => {
    let capturedMessages: { role: string; content: string }[] = [];
    const mockModelClient = {
      chat: async (req: { messages: { role: string; content: string }[] }): Promise<ChatResponse> => {
        capturedMessages = req.messages;
        return {
          id: 'r1', model: 'deepseek-flash',
          content: '先想想：能不能把这个方程化成一般形式 $ax^2+bx+c=0$？试试把所有项移到左边。',
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 5, cost: 0 },
          latencyMs: 5,
        };
      },
    } as unknown as ModelClient;

    const capability = new HintCapability({ modelClient: mockModelClient });
    const result = await capability.generate({
      questionContent: '(1) $5x^{2}-1=4x$',
      subject: 'math',
    });

    // hint/math.md system prompt enforces "绝对不能给出答案" / Socratic 启发
    expect(capturedMessages[0].content).toContain('提示');
    expect(capturedMessages[0].content).toContain('不能');
    // user message carries the question content
    expect(capturedMessages[1].content).toContain('5x^{2}-1=4x');
    expect(result.content).toContain('一般形式');
  });
});
