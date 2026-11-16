import { describe, expect, it } from 'vitest';
import { formatPaperQuestionNo, formatQuestionSource } from './questionSource';

describe('formatQuestionSource', () => {
  it('机器串换成可读标签，试卷名原样返回', () => {
    expect(formatQuestionSource('auxiliary')).toBe('专项补充题');
    expect(formatQuestionSource('freeform')).toBe('答疑录入');
    expect(formatQuestionSource('practice')).toBe('练习录入');
    expect(formatQuestionSource('remediation')).toBe('补偿练习');
    expect(formatQuestionSource('北京市西城区九年级模拟测试试卷')).toBe('北京市西城区九年级模拟测试试卷');
  });

  it('空值返回 null（页面据此不渲染来源行）', () => {
    expect(formatQuestionSource(null)).toBeNull();
    expect(formatQuestionSource(undefined)).toBeNull();
    expect(formatQuestionSource('')).toBeNull();
  });
});

describe('formatPaperQuestionNo', () => {
  it('有卷内题号时展示「试卷第 N 题」，与本次练习位次区分', () => {
    expect(formatPaperQuestionNo(12)).toBe('试卷第 12 题');
  });

  it('无卷关联（null/undefined）返回 null，只显示来源', () => {
    expect(formatPaperQuestionNo(null)).toBeNull();
    expect(formatPaperQuestionNo(undefined)).toBeNull();
  });
});
