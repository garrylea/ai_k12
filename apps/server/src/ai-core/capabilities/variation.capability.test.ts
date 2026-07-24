import { describe, it, expect } from 'vitest';
import { VariationCapability } from './variation.capability.js';
import { ModelClient } from '../infra/model-client/index.js';
import type { ChatResponse } from '../types.js';

describe('VariationCapability', () => {
  it('constructs without error', () => {
    const capability = new VariationCapability();
    expect(capability).toBeDefined();
  });

  it('generates variation questions via mocked model with count/difficulty rendered', async () => {
    let capturedMessages: { role: string; content: string }[] = [];
    const mockContent = JSON.stringify({
      variations: [
        {
          content: '解方程 3x-6=9，求x',
          answer: 'x=5',
          explanation: '3x=9+6=15，x=5',
          difficulty: 2,
          variationType: '换数',
        },
      ],
    });
    const mockModelClient = {
      chat: async (req: { messages: { role: string; content: string }[] }): Promise<ChatResponse> => {
        capturedMessages = req.messages;
        return {
          id: 'r1', model: 'qwen3.7-max', content: mockContent,
          finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, cost: 0 }, latencyMs: 5,
        };
      },
    } as unknown as ModelClient;

    const capability = new VariationCapability({ modelClient: mockModelClient });
    const result = await capability.generate({
      originalQuestion: { content: '解方程 2x+3=7', answer: 'x=2', difficulty: 1 },
      knowledgePoint: { id: 'kp1', name: '一元一次方程' },
      count: 3,
      targetDifficulty: 2,
    });

    // count and difficulty customVariables render into the user message
    // (template wraps labels in **bold**, so assert with the markers)
    expect(capturedMessages[1].content).toContain('**生成数量**：3 道');
    expect(capturedMessages[1].content).toContain('**目标难度**：2');
    expect(capturedMessages[1].content).not.toContain('{{');
    expect(result.variations).toHaveLength(1);
    expect(result.variations[0].answer).toBe('x=5');
    expect(result.variations[0].variationType).toBe('换数');
    expect(result.generatedBy).toBeTruthy();
  });
});
