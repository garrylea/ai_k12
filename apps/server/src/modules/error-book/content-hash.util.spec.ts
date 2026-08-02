import { describe, it, expect } from 'vitest';
import { normalizeForHash, computeContentHash } from './content-hash.util.js';

describe('content-hash', () => {
  it('strips whitespace', () => {
    expect(computeContentHash('1 + 1 = ?')).toBe(computeContentHash('1+1=?'));
  });
  it('strips CJK punctuation', () => {
    expect(computeContentHash('求x的值。')).toBe(computeContentHash('求x的值'));
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
