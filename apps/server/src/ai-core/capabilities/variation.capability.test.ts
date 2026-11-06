import { describe, it, expect } from 'vitest';
import { VariationCapability } from './variation.capability.js';
import { ModelClient } from '../infra/model-client/index.js';
import { timeoutConfig } from '../config.js';
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

  // 2026-11-06：subject 决定 prompt 与路由；不传仍是数学（既有调用方零改动）。
  describe('subject 分流', () => {
    const mockContent = JSON.stringify({
      variations: [{ content: '题', answer: 'A', explanation: '解析', difficulty: 2, variationType: '换数' }],
    });

    function makeSpy() {
      const calls: {
        messages: { role: string; content: string }[]; timeout?: number; maxRetries?: number;
      }[] = [];
      const modelClient = {
        chat: async (req: {
          messages: { role: string; content: string }[]; timeout?: number; maxRetries?: number;
        }): Promise<ChatResponse> => {
          calls.push(req);
          return {
            id: 'r1', model: 'qwen3.8-max', content: mockContent,
            finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, cost: 0 }, latencyMs: 5,
          };
        },
      } as unknown as ModelClient;
      return { calls, capability: new VariationCapability({ modelClient }) };
    }

    it('physics -> 物理 prompt + timeoutMs 生效', async () => {
      const { calls, capability } = makeSpy();
      await capability.generate({
        originalQuestion: { content: '一辆车 20m/s 行驶 10s', answer: '200m', difficulty: 2 },
        knowledgePoint: { id: 'kp1', name: '速度' },
        count: 1,
        subject: 'physics',
        timeoutMs: 20000,
      });
      const system = calls[0].messages[0].content;
      expect(system).toContain('物理命题专家');
      expect(system).not.toContain('数学命题专家');
      expect(calls[0].timeout).toBe(20000);
    });

    it('不传 subject -> 数学 prompt + retry.yaml 的 variation 超时', async () => {
      const { calls, capability } = makeSpy();
      await capability.generate({
        originalQuestion: { content: '解方程 2x+3=7', answer: 'x=2', difficulty: 1 },
        knowledgePoint: { id: 'kp1', name: '一元一次方程' },
        count: 1,
      });
      expect(calls[0].messages[0].content).toContain('数学命题专家');
      expect(calls[0].timeout).toBe(timeoutConfig.timeout.variation ?? timeoutConfig.timeout.default);
      // 不传 maxRetries -> 不下发，沿用模型客户端全局重试策略
      expect(calls[0].maxRetries).toBeUndefined();
    });

    // 2026-11-06：同类型练习补题要求「失败即降级」，故按请求关闭重试。
    it('maxRetries=0 透传到模型客户端', async () => {
      const { calls, capability } = makeSpy();
      await capability.generate({
        originalQuestion: { content: '解方程 2x+3=7', answer: 'x=2', difficulty: 1 },
        knowledgePoint: { id: 'kp1', name: '一元一次方程' },
        count: 1,
        maxRetries: 0,
      });
      expect(calls[0].maxRetries).toBe(0);
    });
  });
});
