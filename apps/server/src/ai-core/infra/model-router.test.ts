import { describe, it, expect } from 'vitest';
import { ModelRouter } from './model-router.js';

describe('ModelRouter', () => {
  const router = new ModelRouter();

  it('routes math tutoring (easy) to qwen3.7-max primary with deepseek fallback', () => {
    const result = router.route({ scene: 'tutoring', subject: 'math', difficulty: 1 });
    expect(result.primary.modelId).toBe('qwen3.7-max');
    expect(result.fallback?.modelId).toBe('deepseek-v4-flash');
  });

  it('routes math tutoring (hard) to gemini-3.1-pro primary with qwen fallback', () => {
    const result = router.route({ scene: 'tutoring', subject: 'math', difficulty: 3 });
    expect(result.primary.modelId).toBe('gemini-3.1-pro');
    expect(result.fallback?.modelId).toBe('qwen3.7-max');
  });

  it('routes safety scene to deepseek-v4-flash with no fallback', () => {
    const result = router.route({ scene: 'safety', subject: 'math' });
    expect(result.primary.modelId).toBe('deepseek-v4-flash');
    expect(result.fallback).toBeUndefined();
  });

  it('routes chinese tutoring to kimi primary', () => {
    const result = router.route({ scene: 'tutoring', subject: 'chinese' });
    expect(result.primary.modelId).toBe('kimi-latest');
  });

  it('falls back to default when scene not in route table', () => {
    const result = router.route({ scene: 'analysis', subject: 'math' });
    expect(result.primary.modelId).toBe('kimi-latest');
    expect(result.fallback?.modelId).toBe('qwen3.7-max');
  });

  it('matches without difficulty (loose match)', () => {
    const result = router.route({ scene: 'grading', subject: 'math' });
    expect(result.primary.modelId).toBe('qwen3.7-max');
  });
});
