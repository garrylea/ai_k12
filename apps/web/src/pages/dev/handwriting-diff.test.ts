import { describe, it, expect } from 'vitest';
import { normalizeForCompare, compareHandwriting } from './handwriting-diff';

describe('normalizeForCompare', () => {
  it('去空白、去中西文标点、全角转半角、英文小写', () => {
    expect(normalizeForCompare(' 春天，真好！ABC　ｄｅｆ ')).toBe('春天真好abcdef');
    expect(normalizeForCompare('——「引号」、逗号。')).toBe('引号逗号');
  });
});

describe('compareHandwriting', () => {
  it('完全一致 → accuracy 1，无错误', () => {
    const r = compareHandwriting('今天天气很好', '今天，天气很好。');
    expect(r.accuracy).toBe(1);
    expect(r.matched).toBe(6);
    expect(r.errors).toEqual([]);
    expect(r.extra).toEqual([]);
  });

  it('错一个字 → 该字进 errors（expected 带 got）', () => {
    const r = compareHandwriting('今天天气很好', '今天田气很好');
    expect(r.accuracy).toBeCloseTo(5 / 6);
    expect(r.errors).toEqual([{ expected: '天', got: '田' }]);
    expect(r.extra).toEqual([]);
  });

  it('漏一个字 → errors 里 got=null', () => {
    const r = compareHandwriting('今天天气很好', '今天气很好');
    expect(r.accuracy).toBeCloseTo(5 / 6);
    expect(r.errors).toEqual([{ expected: '天', got: null }]);
  });

  it('多一个字 → 进 extra，不冲抵准确率', () => {
    const r = compareHandwriting('你好', '你号呀');
    // LCS 对齐：「你」配「你」→ 期望「好」对识别「号」是错字，识别「呀」是多出
    expect(r.matched).toBe(1);
    expect(r.accuracy).toBeCloseTo(1 / 2);
    expect(r.errors).toEqual([{ expected: '好', got: '号' }]);
    expect(r.extra).toEqual(['呀']);
  });

  it('期望为空：识别也空 = 1，识别非空 = 0 且全进 extra', () => {
    expect(compareHandwriting('', '').accuracy).toBe(1);
    const r = compareHandwriting('', 'abc');
    expect(r.accuracy).toBe(0);
    expect(r.extra).toEqual(['a', 'b', 'c']);
  });
});
