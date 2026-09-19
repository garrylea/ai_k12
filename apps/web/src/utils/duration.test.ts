import { describe, it, expect } from 'vitest';
import { formatDuration } from './duration';

describe('formatDuration', () => {
  it('不足 1 分钟 → 「不足 1 分钟」（不显示 0 分钟，那读起来像没学）', () => {
    expect(formatDuration(0)).toBe('不足 1 分钟');
    expect(formatDuration(59)).toBe('不足 1 分钟');
  });

  it('整分钟', () => {
    expect(formatDuration(60)).toBe('1 分钟');
    expect(formatDuration(48 * 60)).toBe('48 分钟');
  });

  it('小时 + 分钟', () => {
    expect(formatDuration(3661)).toBe('1 小时 1 分');
    expect(formatDuration(2 * 3600 + 5 * 60)).toBe('2 小时 5 分');
  });

  it('整小时不带「0 分」', () => {
    expect(formatDuration(2 * 3600)).toBe('2 小时');
  });

  it('负数 / NaN 兜底为「不足 1 分钟」（不抛错，页面不该被脏数据打崩）', () => {
    expect(formatDuration(-5)).toBe('不足 1 分钟');
    expect(formatDuration(Number.NaN)).toBe('不足 1 分钟');
  });
});
