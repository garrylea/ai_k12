import { describe, it, expect } from 'vitest';
import { resolveSeedRoute } from './llm-route-seed.util.js';

describe('resolveSeedRoute', () => {
  it('主备都已配置：原样落库，不降级不跳过', () => {
    const r = resolveSeedRoute(
      { subject: 'math', primary: 'local', fallback: 'deepseek-v4-flash' },
      new Set(['local', 'deepseek-v4-flash']),
    );
    expect(r).toEqual({ primary: 'local', fallback: 'deepseek-v4-flash', degraded: false, skipped: false });
  });

  it('主已配置、备未配置：备用置空，不跳过', () => {
    const r = resolveSeedRoute(
      { subject: 'math', primary: 'local', fallback: 'deepseek-v4-flash' },
      new Set(['local']),
    );
    expect(r).toEqual({ primary: 'local', fallback: null, degraded: false, skipped: false });
  });

  it('主已配置、无备用：备用为 null', () => {
    const r = resolveSeedRoute(
      { subject: 'math', primary: 'deepseek-v4-flash' },
      new Set(['deepseek-v4-flash']),
    );
    expect(r).toEqual({ primary: 'deepseek-v4-flash', fallback: null, degraded: false, skipped: false });
  });

  it('主未配置、备已配置：降级 —— 备用顶上当主模型', () => {
    const r = resolveSeedRoute(
      { subject: 'math', primary: 'local', fallback: 'deepseek-v4-flash' },
      new Set(['deepseek-v4-flash']),
    );
    expect(r).toEqual({ primary: 'deepseek-v4-flash', fallback: null, degraded: true, skipped: false });
  });

  it('主未配置、无备用：跳过', () => {
    const r = resolveSeedRoute(
      { subject: 'math', primary: 'local' },
      new Set(['deepseek-v4-flash']),
    );
    expect(r).toEqual({ primary: 'local', fallback: null, degraded: false, skipped: true });
  });

  it('主备都未配置：跳过', () => {
    const r = resolveSeedRoute(
      { subject: 'math', primary: 'local', fallback: 'deepseek-v4-flash' },
      new Set(),
    );
    expect(r).toEqual({ primary: 'local', fallback: 'deepseek-v4-flash', degraded: false, skipped: true });
  });
});
