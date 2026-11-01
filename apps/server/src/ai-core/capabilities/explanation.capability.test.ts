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
          id: 'r1', model: 'qwen3.7-max',
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
          id: 'r2', model: 'qwen3.7-max',
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
    // errorHistory is passed as an array and the {{#errorHistory}} section
    // iterates it, rendering each past attempt (not a JSON dump).
    expect(capturedMessages[1].content).toContain('题目：解方程 2x+3=7');
    expect(capturedMessages[1].content).toContain('错误答案：x=3');
    expect(capturedMessages[1].content).toContain('第2次尝试');
    expect(capturedMessages[1].content).not.toContain('[object Object]');
  });

  it('solution 模式：把选项和学科角色交给模型，并禁止顺着参考答案编理由', async () => {
    let capturedMessages: { role: string; content: string }[] = [];
    const mockModelClient = {
      chat: async (req: { messages: { role: string; content: string }[] }): Promise<ChatResponse> => {
        capturedMessages = req.messages;
        return {
          id: 'r3', model: 'qwen3.8-max',
          content: '电阻的单位是欧姆。',
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 5, cost: 0 },
          latencyMs: 5,
        };
      },
    } as unknown as ModelClient;

    const capability = new ExplanationCapability({ modelClient: mockModelClient });
    await capability.explain({
      mode: 'solution',
      studentId: '',
      subject: 'math',
      subjectLabel: '物理',
      question: {
        content: '在国际单位制中，电阻的单位是',
        answer: 'C',
        options: [
          { label: 'A', text: '安培(A)' },
          { label: 'B', text: '伏特(V)' },
          { label: 'C', text: '欧姆(Ω)' },
          { label: 'D', text: '库仑(C)' },
        ],
      },
      wrongAnswer: '',
      knowledgePoint: { id: '', name: '' },
    });

    const system = capturedMessages[0].content;
    const user = capturedMessages[1].content;

    // 角色按真实学科，不是写死的数学老师
    expect(system).toContain('中学物理老师');
    // 冲突时以推导为准，不许反向编理由
    expect(system).toContain('以你的推导为准');
    expect(system).toContain('禁止');
    // 四个选项逐个进提示词（此前一个都不给 → 模型只能顺着「参考答案：D」圆）
    expect(user).toContain('A. 安培(A)');
    expect(user).toContain('B. 伏特(V)');
    expect(user).toContain('C. 欧姆(Ω)');
    expect(user).toContain('D. 库仑(C)');
    expect(user).not.toContain('{{');
  });
});
