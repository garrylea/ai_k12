import { describe, it, expect } from 'vitest';
import { GradingCapability } from './grading.capability.js';
import { ModelClient } from '../infra/model-client/index.js';
import type { ChatResponse } from '../types.js';

describe('GradingCapability', () => {
  it('constructs without error', () => {
    const capability = new GradingCapability();
    expect(capability).toBeDefined();
  });

  it('does not retry when step sum matches total score', () => {
    const capability = new GradingCapability();
    const needsRetry = capability.needsRetry({
      totalScore: 8, maxScore: 10,
      steps: [
        { stepNumber: 1, description: 'step1', score: 4, maxScore: 5, isCorrect: true, comment: '' },
        { stepNumber: 2, description: 'step2', score: 4, maxScore: 5, isCorrect: true, comment: '' },
      ],
      feedback: '', suggestions: [],
    });
    // stepSum=8, totalScore=8, deviation=0% -> no retry
    expect(needsRetry).toBe(false);
  });

  it('triggers retry when deviation exceeds 20%', () => {
    const capability = new GradingCapability();
    const needsRetry = capability.needsRetry({
      totalScore: 5, maxScore: 10,
      steps: [
        { stepNumber: 1, description: 'step1', score: 5, maxScore: 5, isCorrect: true, comment: '' },
        { stepNumber: 2, description: 'step2', score: 5, maxScore: 5, isCorrect: true, comment: '' },
      ],
      feedback: '', suggestions: [],
    });
    // stepSum=10, totalScore=5, deviation=50% -> retry
    expect(needsRetry).toBe(true);
  });

  it('grades a student answer via mocked model', async () => {
    const mockContent = JSON.stringify({
      totalScore: 8, maxScore: 10,
      steps: [
        { stepNumber: 1, description: '设未知数', score: 4, maxScore: 5, isCorrect: true, comment: '正确' },
        { stepNumber: 2, description: '求解', score: 4, maxScore: 5, isCorrect: true, comment: '正确' },
      ],
      feedback: '过程正确', suggestions: ['继续努力'],
    });
    const mockModelClient = {
      chat: async (): Promise<ChatResponse> => ({
        id: 'r1', model: 'qwen-3.7-max', content: mockContent,
        finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, cost: 0 }, latencyMs: 5,
      }),
    } as unknown as ModelClient;

    const capability = new GradingCapability({ modelClient: mockModelClient });
    const result = await capability.grade({
      questionId: 'q1',
      questionType: 'calculation',
      subject: 'math',
      questionContent: '解方程 2x+3=7',
      standardAnswer: 'x=2',
      maxScore: 10,
      studentAnswer: 'x=3',
    });

    expect(result.totalScore).toBe(8);
    expect(result.maxScore).toBe(10);
    expect(result.steps).toHaveLength(2);
    expect(result.feedback).toBe('过程正确');
  });
});
