import { describe, it, expect } from 'vitest';
import { normalizeForHash, computeContentHash } from './content-hash.util.js';

describe('content-hash', () => {
  it('strips whitespace', () => {
    expect(computeContentHash('1 + 1 = ?')).toBe(computeContentHash('1+1=?'));
  });
  it('preserves CJK punctuation (NFKC alignment with refinery)', () => {
    expect(normalizeForHash('求x的值。')).toBe('求x的值。');
  });
  it('converts fullwidth digits to halfwidth', () => {
    expect(computeContentHash('１２３')).toBe(computeContentHash('123'));
  });
  it('folds case', () => {
    expect(computeContentHash('ABC')).toBe(computeContentHash('abc'));
  });
  it('different content produces different hash', () => {
    expect(computeContentHash('1+1=?')).not.toBe(computeContentHash('2+2=?'));
  });
  it('normalizeForHash returns string', () => {
    expect(typeof normalizeForHash('test')).toBe('string');
  });
});

describe('content-hash NFKC alignment', () => {
  it('全角括号/数字/上标 NFKC 归一', () => {
    expect(normalizeForHash('（1）x²=4')).toBe(normalizeForHash('(1)x2=4'));
  });
  it('与 refinery normalize_content 同口径（不删标点）', () => {
    expect(normalizeForHash('A,B')).toBe('a,b');
  });
  it('等价哈希', () => {
    expect(computeContentHash('（1）x²=4')).toBe(computeContentHash('(1)x2=4'));
  });
});
