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

  it('routes structuring scene to deepseek-v4-flash', () => {
    const result = router.route({ scene: 'structuring', subject: 'math' });
    expect(result.primary.modelId).toBe('deepseek-v4-flash');
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

  // Task 14a: image-aware routing
  it('routes math tutoring with image to qwen-vl-max', () => {
    const result = router.route({ scene: 'tutoring', subject: 'math', hasImage: true });
    expect(result.primary.modelId).toBe('qwen-vl-max');
    expect(result.fallback?.modelId).toBe('qwen3.7-max');
  });

  it('does not route to qwen-vl-max when hasImage is false', () => {
    const result = router.route({ scene: 'tutoring', subject: 'math', hasImage: false });
    expect(result.primary.modelId).not.toBe('qwen-vl-max');
  });

  it('does not route to qwen-vl-max for non-tutoring scenes even with image', () => {
    const result = router.route({ scene: 'grading', subject: 'math', hasImage: true });
    expect(result.primary.modelId).not.toBe('qwen-vl-max');
  });

  it('hasImage detects image_url parts in messages', () => {
    const messagesWithImage = [
      { role: 'user' as const, content: [{ type: 'text' as const, text: '看这道题' }, { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,abc' } }] },
    ];
    expect(router.hasImage(messagesWithImage)).toBe(true);
  });

  it('hasImage returns false for text-only messages', () => {
    const textMessages = [
      { role: 'user' as const, content: '一元一次方程怎么解？' },
    ];
    expect(router.hasImage(textMessages)).toBe(false);
  });

  it('hasImage returns false for array content without image_url', () => {
    const textArrayMessages = [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'just text' }] },
    ];
    expect(router.hasImage(textArrayMessages)).toBe(false);
  });
});
