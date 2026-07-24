import { describe, it, expect } from 'vitest';
import { FallbackHandler } from './fallback-handler.js';

const fakeContent = `## 知识点总结
一元一次方程的标准形式是 ax+b=0。

## 建议
- 多做练习
- 理解移项
- 检查符号`;

function makeDeps(chatContent = fakeContent) {
  return {
    promptBuilder: { build: async () => ({ messages: [], estimatedTokens: 0, templateVersion: '1.0' }) },
    modelClient: { chat: async () => ({ content: chatContent, id: 'r1', model: 'qwen-3.7-max', finishReason: 'stop' as const, usage: { inputTokens: 0, outputTokens: 0, cost: 0 }, latencyMs: 5 }) },
    modelRouter: { route: () => ({ primary: { modelId: 'qwen-3.7-max' }, reason: 'test' }) },
  };
}

describe('FallbackHandler', () => {
  it('constructs without error', () => {
    const handler = new FallbackHandler(makeDeps() as any);
    expect(handler).toBeDefined();
  });

  it('handle() returns fallback response with summary and recommendations extracted', async () => {
    const handler = new FallbackHandler(makeDeps() as any);
    const result = await handler.handle({
      studentId: 's1',
      dialogueId: 'd1',
      knowledgePoint: { id: 'kp1', name: '一元一次方程', subject: 'math' },
      dialogueHistory: [],
      track: 'mainline',
    });
    expect(result.type).toBe('fallback');
    expect(result.includesCompleteAnswer).toBe(true);
    expect(result.content).toBe(fakeContent);
    expect(result.summary).toContain('一元一次方程');
    expect(result.recommendations).toHaveLength(3);
    expect(result.recommendations).toContain('多做练习');
    expect(result.recommendations).toContain('理解移项');
    expect(result.recommendations).toContain('检查符号');
  });

  it('handle() falls back to content slice when no summary section found', async () => {
    const handler = new FallbackHandler(makeDeps('no structured sections here, just plain text that is longer than two hundred characters. ' + 'x'.repeat(250)) as any);
    const result = await handler.handle({
      studentId: 's1', dialogueId: 'd1',
      knowledgePoint: { id: 'kp1', name: 'kp', subject: 'math' },
      dialogueHistory: [], track: 'mainline',
    });
    expect(result.summary.length).toBeLessThanOrEqual(200);
  });
});
