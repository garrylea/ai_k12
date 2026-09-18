import { describe, it, expect } from 'vitest';
import { toRate } from './rate.util.js';

describe('toRate', () => {
  it('保留一位小数', () => {
    expect(toRate(42, 31)).toBe(73.8);
    expect(toRate(3, 1)).toBe(33.3);
  });

  it('满分与零分', () => {
    expect(toRate(10, 10)).toBe(100);
    expect(toRate(10, 0)).toBe(0);
  });

  it('answered = 0 → null（不是 0）', () => {
    expect(toRate(0, 0)).toBeNull();
    expect(toRate(-1, 0)).toBeNull();
  });
});
