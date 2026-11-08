import { describe, it, expect } from 'vitest';
import {
  normalizeForHash,
  computeContentHash,
  stripMarkdownImages,
  computeFreeformContentHash,
} from './content-hash.util.js';

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

describe('content-hash freeform（先剥 Markdown 图片再哈希）', () => {
  it('去 Markdown 图片后同题干 hash 相同', () => {
    const a = computeFreeformContentHash('已知 ![图](https://x/a.jpg) 求 x');
    const b = computeFreeformContentHash('已知 ![图](https://x/b.jpg) 求 x');
    expect(a).toBe(b);
  });
  it('纯文字与原 hash 一致', () => {
    expect(computeFreeformContentHash('x+1=2')).toBe(computeContentHash('x+1=2'));
  });
  it('stripMarkdownImages 同时去掉图片与 <!-- page N --> 页码标记', () => {
    expect(stripMarkdownImages('![图](/uploads/a.png)\n<!-- page 3 -->\n求 x')).toBe('求 x');
  });
  it('stripMarkdownImages 去掉任意 HTML 注释（不限于 page 标记）', () => {
    expect(stripMarkdownImages('求 x <!-- 内部备注：勿删 -->')).toBe('求 x');
  });
  it('纯图片内容（仅图片 URL 不同）hash 不同，不塌缩成 sha256("")', () => {
    const a = computeFreeformContentHash('![图](https://x/a.jpg)');
    const b = computeFreeformContentHash('![图](https://x/b.jpg)');
    expect(a).not.toBe(b);
    expect(a).not.toBe(computeContentHash(''));
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
