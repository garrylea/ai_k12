import { describe, expect, it } from 'vitest';
import { formatQuestionSource } from './questionSource';

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
