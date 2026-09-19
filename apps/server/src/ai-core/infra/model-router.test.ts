import { describe, it, expect } from 'vitest';
import { ModelRouter } from './model-router.js';

describe('ModelRouter', () => {
  const router = new ModelRouter();

  it('routes math tutoring (easy) to qwen3.8-max primary with deepseek fallback', () => {
    const result = router.route({ scene: 'tutoring', subject: 'math', difficulty: 1 });
    expect(result.primary.modelId).toBe('qwen3.8-max');
    expect(result.fallback?.modelId).toBe('deepseek-flash');
  });

  it('routes math tutoring (hard) to gemini-3.1-pro primary with qwen fallback', () => {
    const result = router.route({ scene: 'tutoring', subject: 'math', difficulty: 3 });
    expect(result.primary.modelId).toBe('gemini-3.1-pro');
    expect(result.fallback?.modelId).toBe('qwen3.8-max');
  });

  it('routes safety scene to deepseek-flash with no fallback', () => {
    const result = router.route({ scene: 'safety', subject: 'math' });
    expect(result.primary.modelId).toBe('deepseek-flash');
    expect(result.fallback).toBeUndefined();
  });

  it('routes structuring scene to deepseek-flash', () => {
    const result = router.route({ scene: 'structuring', subject: 'math' });
    expect(result.primary.modelId).toBe('deepseek-flash');
  });

  it('routes chinese tutoring to kimi primary', () => {
    const result = router.route({ scene: 'tutoring', subject: 'chinese' });
    expect(result.primary.modelId).toBe('kimi-latest');
  });

  it('falls back to default when scene not in route table', () => {
    const result = router.route({ scene: 'analysis', subject: 'math' });
    expect(result.primary.modelId).toBe('kimi-latest');
    expect(result.fallback?.modelId).toBe('qwen3.8-max');
  });

  it('matches without difficulty (loose match)', () => {
    const result = router.route({ scene: 'grading', subject: 'math' });
    expect(result.primary.modelId).toBe('deepseek-flash');
    expect(result.fallback?.modelId).toBe('qwen3.8-max');
  });

  it('routes math judgment to local primary with qwen3.8-max fallback', () => {
    // 训练模块判题默认走本地 llama.cpp；本地不可用回退 qwen3.8-max（无 thinking，见 JudgmentCapability）
    const result = router.route({ scene: 'judgment', subject: 'math' });
    expect(result.primary.modelId).toBe('Qwen3.8-27B');
    expect(result.primary.provider).toBe('local');
    expect(result.fallback?.modelId).toBe('qwen3.8-max');
  });

  it('tutoring ignores hasImage and uses the text model (image is sent directly)', () => {
    const result = router.route({ scene: 'tutoring', subject: 'math', hasImage: true });
    expect(result.primary.modelId).toBe('qwen3.8-max');
  });

  it('does not route to a VL model for non-tutoring scenes even with image', () => {
    const result = router.route({ scene: 'grading', subject: 'math', hasImage: true });
    expect(result.primary.modelId).toBe('deepseek-flash');
  });

  it('route() 给 primary/fallback 打 scene/subject/modelKey；fallback 额外带 isFallbackEntry', () => {
    const result = new ModelRouter().route({ scene: 'judgment', subject: 'math' });
    expect(result.primary.scene).toBe('judgment');
    expect(result.primary.subject).toBe('math');
    expect(result.primary.modelKey).toBeTruthy();
    expect(result.primary.isFallbackEntry).toBeUndefined();
    if (result.fallback) {
      expect(result.fallback.isFallbackEntry).toBe(true);
      expect(result.fallback.modelKey).toBeTruthy();
      expect(result.fallback.scene).toBe('judgment');
    }
  });
});
