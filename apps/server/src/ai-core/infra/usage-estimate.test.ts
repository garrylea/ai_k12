import { describe, it, expect } from 'vitest';
import { estimateTokens } from './usage-estimate';

describe('estimateTokens（流式拿不到 usage 时的兜底）', () => {
  it('纯中文按 1 字 = 1 token', () => {
    expect(estimateTokens('你好世界')).toBe(4);
  });

  it('纯拉丁按 4 字符 = 1 token，向上取整', () => {
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('中英混合分别计数后相加', () => {
    // 3 个中文 = 3；'abcdefgh' = 2 => 5
    expect(estimateTokens('你好吗abcdefgh')).toBe(5);
  });

  it('空白与空串为 0', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('   ')).toBe(0);
  });

  it('半角标点算作拉丁字符（去空格后 12 字符 → ceil(12/4)=3）', () => {
    expect(estimateTokens('hello, world!')).toBe(3);
  });
});
