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
        id: 'r1', model: 'qwen3.7-max', content: mockContent,
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

  it('needsRetry flags contradiction when all steps score 0 but totalScore > 0', () => {
    const capability = new GradingCapability();
    const needsRetry = capability.needsRetry({
      totalScore: 5, maxScore: 10,
      steps: [
        { stepNumber: 1, description: 's1', score: 0, maxScore: 5, isCorrect: false, comment: '' },
        { stepNumber: 2, description: 's2', score: 0, maxScore: 5, isCorrect: false, comment: '' },
      ],
      feedback: '', suggestions: [],
    });
    // stepSum=0, totalScore=5 -> deviation 5/5=1.0 > 0.2 -> retry (previously returned false).
    expect(needsRetry).toBe(true);
  });

  it('retries on the fallback model when step sum deviates, and returns the retry result', async () => {
    const inconsistent = JSON.stringify({
      totalScore: 5, maxScore: 10,
      steps: [
        { stepNumber: 1, description: 's1', score: 5, maxScore: 5, isCorrect: true, comment: '' },
        { stepNumber: 2, description: 's2', score: 5, maxScore: 5, isCorrect: true, comment: '' },
      ],
      feedback: '', suggestions: [],
    });
    const consistent = JSON.stringify({
      totalScore: 9, maxScore: 10,
      steps: [
        { stepNumber: 1, description: 's1', score: 4, maxScore: 5, isCorrect: true, comment: '' },
        { stepNumber: 2, description: 's2', score: 5, maxScore: 5, isCorrect: true, comment: '' },
      ],
      feedback: 'ok', suggestions: [],
    });
    let callCount = 0;
    const mockModelClient = {
      chat: async (): Promise<ChatResponse> => {
        callCount++;
        return {
          id: `r${callCount}`, model: callCount === 1 ? 'qwen3.7-max' : 'kimi-latest',
          content: callCount === 1 ? inconsistent : consistent,
          finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, cost: 0 }, latencyMs: 5,
        };
      },
    } as unknown as ModelClient;

    const capability = new GradingCapability({ modelClient: mockModelClient });
    const result = await capability.grade({
      questionId: 'q1', questionType: 'calculation', subject: 'math',
      questionContent: '解方程 2x+3=7', standardAnswer: 'x=2', maxScore: 10, studentAnswer: 'x=3',
    });

    // First attempt: stepSum=10 vs totalScore=5 -> needsRetry -> fallback called.
    expect(callCount).toBe(2);
    expect(result.totalScore).toBe(9); // retry result returned
  });

  it('returns the original result if the retry call throws', async () => {
    const inconsistent = JSON.stringify({
      totalScore: 5, maxScore: 10,
      steps: [
        { stepNumber: 1, description: 's1', score: 5, maxScore: 5, isCorrect: true, comment: '' },
        { stepNumber: 2, description: 's2', score: 5, maxScore: 5, isCorrect: true, comment: '' },
      ],
      feedback: '', suggestions: [],
    });
    let callCount = 0;
    const mockModelClient = {
      chat: async (): Promise<ChatResponse> => {
        callCount++;
        if (callCount === 1) {
          return { id: 'r1', model: 'qwen3.7-max', content: inconsistent, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, cost: 0 }, latencyMs: 5 };
        }
        throw new Error('fallback model failed');
      },
    } as unknown as ModelClient;

    const capability = new GradingCapability({ modelClient: mockModelClient });
    const result = await capability.grade({
      questionId: 'q1', questionType: 'calculation', subject: 'math',
      questionContent: '解方程 2x+3=7', standardAnswer: 'x=2', maxScore: 10, studentAnswer: 'x=3',
    });

    // Retry threw, but the original (suspicious but parseable) result is returned.
    expect(callCount).toBe(2);
    expect(result.totalScore).toBe(5);
  });
});
