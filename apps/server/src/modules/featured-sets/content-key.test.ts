import { describe, expect, it } from 'vitest';
import { createFeaturedContentKey } from './content-key.js';

describe('createFeaturedContentKey', () => {
  it('忽略题目顺序并对题目去重', () => {
    expect(createFeaturedContentKey(1, [9, 3, 9, 7]))
      .toBe(createFeaturedContentKey(1, [7, 3, 9]));
  });

  it('学科或题目集合不同则不同', () => {
    expect(createFeaturedContentKey(1, [1, 2]))
      .not.toBe(createFeaturedContentKey(2, [1, 2]));
    expect(createFeaturedContentKey(1, [1, 2]))
      .not.toBe(createFeaturedContentKey(1, [1, 3]));
  });
});
