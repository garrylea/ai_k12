import { describe, expect, it } from 'vitest';
import { parseOptions } from './parse-options.util';

describe('parseOptions', () => {
  it('读取时剥掉历史数据里的 isCorrect', () => {
    expect(parseOptions('[{"label":"A","text":"1","isCorrect":true}]')).toEqual([
      { label: 'A', text: '1' },
    ]);
  });

  it('坏 JSON / 非数组仍返回 null', () => {
    expect(parseOptions('{bad')).toBeNull();
    expect(parseOptions('{"a":1}')).toBeNull();
  });
});
