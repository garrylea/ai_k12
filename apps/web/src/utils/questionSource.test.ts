import { describe, expect, it } from 'vitest';
import { formatPaperQuestionNo } from './questionSource';

describe('formatPaperQuestionNo', () => {
  it('无小问', () => expect(formatPaperQuestionNo(26)).toBe('试卷第 26 题'));
  it('有小问', () => expect(formatPaperQuestionNo(26, 1)).toBe('试卷第 26 题(1)'));
  it('subNo=0 当没有', () => expect(formatPaperQuestionNo(26, 0)).toBe('试卷第 26 题'));
  it('空值', () => expect(formatPaperQuestionNo(null)).toBeNull());
});
