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
    expect(result.primary.modelId).toBe('deepseek-v4-flash');
    expect(result.fallback?.modelId).toBe('qwen3.7-max');
  });

  it('routes math judgment to deepseek-v4-flash primary with qwen fallback', () => {
    // qwen3.7-max (reasoner) 难题判定常超时 -> 改用 deepseek-v4-flash（同 grading）
    const result = router.route({ scene: 'judgment', subject: 'math' });
    expect(result.primary.modelId).toBe('deepseek-v4-flash');
    expect(result.fallback?.modelId).toBe('qwen3.7-max');
  });

  // P1: image tutoring is two-stage. Tutoring no longer overrides to a VL model
  // on hasImage - images are transcribed by the `transcribe` scene first, then
  // the confirmed text is tutored by the normal text route (qwen3.7-max).
  it('tutoring ignores hasImage and uses the text model (P1)', () => {
    const result = router.route({ scene: 'tutoring', subject: 'math', hasImage: true });
    expect(result.primary.modelId).toBe('qwen3.7-max');
  });

  it('does not route to qwen-vl-max when hasImage is false', () => {
    const result = router.route({ scene: 'tutoring', subject: 'math', hasImage: false });
    expect(result.primary.modelId).not.toBe('qwen-vl-max');
  });

  it('transcribe scene routes to qwen3-vl-plus (P1)', () => {
    const result = router.route({ scene: 'transcribe', subject: 'math' });
    expect(result.primary.modelId).toBe('qwen3-vl-plus');
    expect(result.fallback?.modelId).toBe('qwen-vl-max');
  });

  it('does not route to qwen-vl-max for non-tutoring scenes even with image', () => {
    const result = router.route({ scene: 'grading', subject: 'math', hasImage: true });
    expect(result.primary.modelId).not.toBe('qwen-vl-max');
  });
});
