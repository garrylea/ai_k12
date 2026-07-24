import { describe, it, expect } from 'vitest';
import { ExplanationCapability } from './explanation.capability.js';
import { ModelClient } from '../infra/model-client/index.js';
import type { ChatResponse } from '../types.js';

describe('ExplanationCapability', () => {
  it('constructs without error', () => {
    const capability = new ExplanationCapability();
    expect(capability).toBeDefined();
  });

  it('loads error-analysis template and returns parsed content for error_analysis mode', async () => {
    let capturedMessages: { role: string; content: string }[] = [];
    const mockModelClient = {
      chat: async (req: { messages: { role: string; content: string }[] }): Promise<ChatResponse> => {
        capturedMessages = req.messages;
        return {
          id: 'r1', model: 'qwen-3.7-max',
          content: '错因分析完成：你把符号搞错了。',
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 5, cost: 0 },
          latencyMs: 5,
        };
      },
    } as unknown as ModelClient;

    const capability = new ExplanationCapability({ modelClient: mockModelClient });
    const result = await capability.explain({
      mode: 'error_analysis',
      studentId: 's1',
      subject: 'math',
      question: { content: '解方程 2x+3=7', answer: 'x=2' },
      wrongAnswer: 'x=3',
      knowledgePoint: { id: 'kp1', name: '一元一次方程' },
    });

    // error-analysis.md system prompt contains "错因分析"
    expect(capturedMessages[0].content).toContain('错因分析');
    expect(capturedMessages[0].content).not.toContain('重新讲解');
    expect(result.mode).toBe('error_analysis');
    expect(result.content).toBe('错因分析完成：你把符号搞错了。');
  });

  it('loads knowledge-retry template when mode is knowledge_retry', async () => {
    let capturedMessages: { role: string; content: string }[] = [];
    const mockModelClient = {
      chat: async (req: { messages: { role: string; content: string }[] }): Promise<ChatResponse> => {
        capturedMessages = req.messages;
        return {
          id: 'r2', model: 'qwen-3.7-max',
          content: '让我们换个角度重新理解这个知识点。',
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 5, cost: 0 },
          latencyMs: 5,
        };
      },
    } as unknown as ModelClient;

    const capability = new ExplanationCapability({ modelClient: mockModelClient });
    const result = await capability.explain({
      mode: 'knowledge_retry',
      studentId: 's1',
      subject: 'math',
      question: { content: '解方程 2x+3=7', answer: 'x=2' },
      wrongAnswer: 'x=3',
      knowledgePoint: { id: 'kp1', name: '一元一次方程' },
      errorHistory: [{ question: '解方程 2x+3=7', wrongAnswer: 'x=3', attempts: 2 }],
    });

    // knowledge-retry.md system prompt contains "重新讲解", NOT "错因分析"
    expect(capturedMessages[0].content).toContain('重新讲解');
    expect(capturedMessages[0].content).not.toContain('错因分析');
    expect(result.mode).toBe('knowledge_retry');
  });
});
