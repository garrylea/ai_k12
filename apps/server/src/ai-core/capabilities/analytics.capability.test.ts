import { describe, it, expect } from 'vitest';
import { AnalyticsCapability } from './analytics.capability.js';
import { ModelClient } from '../infra/model-client/index.js';
import type { ChatResponse } from '../types.js';

describe('AnalyticsCapability', () => {
  it('constructs without error', () => {
    const capability = new AnalyticsCapability();
    expect(capability).toBeDefined();
  });

  it('generates a report via mocked model with stats rendered in prompt', async () => {
    let capturedMessages: { role: string; content: string }[] = [];
    const mockContent = JSON.stringify({
      reportTitle: '本期学情报告',
      summary: '小明本周进步明显，正确率稳步提升。',
      highlights: [{ icon: 'star', title: '正确率提升', description: '较上周提升10%' }],
      weakPointAnalysis: '一元一次方程的移项操作仍需加强。',
      suggestions: ['每天坚持练习3道一元一次方程题'],
      encouragement: '继续加油，你一定能掌握！',
    });
    const mockModelClient = {
      chat: async (req: { messages: { role: string; content: string }[] }): Promise<ChatResponse> => {
        capturedMessages = req.messages;
        return {
          id: 'r1', model: 'kimi-latest', content: mockContent,
          finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, cost: 0 }, latencyMs: 5,
        };
      },
    } as unknown as ModelClient;

    const capability = new AnalyticsCapability({ modelClient: mockModelClient });
    const result = await capability.generateReport({
      studentId: 's1',
      subject: 'math',
      period: 'weekly',
      stats: {
        totalStudyMinutes: 120,
        completedLessons: 8,
        totalLessons: 10,
        accuracyRate: 85,
        accuracyTrend: [],
        topWeakPoints: [{ knowledgePoint: '一元一次方程', errorCount: 3, mastery: 40 }],
        streak: 5,
        timeDistribution: [],
      },
    });

    // stats object renders via nested Mustache lookup + section iteration
    expect(capturedMessages[1].content).toContain('总学习时长：120 分钟');
    expect(capturedMessages[1].content).toContain('完成课程：8/10');
    expect(capturedMessages[1].content).toContain('正确率：85%');
    expect(capturedMessages[1].content).toContain('一元一次方程（错误 3 次，掌握度 40%）');
    expect(result.reportTitle).toBe('本期学情报告');
    expect(result.suggestions).toHaveLength(1);
    expect(result.encouragement).toContain('继续加油');
  });
});
