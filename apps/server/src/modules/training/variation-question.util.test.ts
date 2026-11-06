import { describe, expect, it } from 'vitest';
import { toStoredAnswer, variationRejectionReason } from './variation-question.util.js';

describe('multi_choice 归一与校验', () => {
  const opts = [
    { label: 'A', text: '甲', isCorrect: false },
    { label: 'B', text: '乙', isCorrect: true },
    { label: 'D', text: '丁', isCorrect: true },
  ];
  it('答案按正确 label 集合排序拼接', () => {
    expect(toStoredAnswer({ content: 'x', answer: 'DB', explanation: '', difficulty: 2, variationType: '换数', options: opts }, 'multi_choice'))
      .toBe('BD');
  });
  it('答案与正确项不一致 -> 拒绝', () => {
    expect(variationRejectionReason(
      { content: 'x', answer: 'AB', explanation: '', difficulty: 2, variationType: '换数', options: opts },
      'multi_choice',
    )).toContain('不一致');
  });
  it('至少一个正确项', () => {
    expect(variationRejectionReason(
      { content: 'x', answer: 'A', explanation: '', difficulty: 2, variationType: '换数', options: opts.map((o) => ({ ...o, isCorrect: false })) },
      'multi_choice',
    )).toContain('至少');
  });

  it('选项不足 2 个 -> 拒绝', () => {
    expect(variationRejectionReason(
      { content: 'x', answer: 'B', explanation: '', difficulty: 2, variationType: '换数', options: [opts[1]] },
      'multi_choice',
    )).toContain('选项不足');
  });

  it('正确答案集合与 submitted 顺序一致时通过', () => {
    expect(variationRejectionReason(
      { content: 'x', answer: 'BD', explanation: '', difficulty: 2, variationType: '换数', options: opts },
      'multi_choice',
    )).toBeNull();
    // 顺序无关：DB 视同 BD
    expect(variationRejectionReason(
      { content: 'x', answer: 'DB', explanation: '', difficulty: 2, variationType: '换数', options: opts },
      'multi_choice',
    )).toBeNull();
  });

  it('选项 label 重复 -> 拒绝（multi_choice），且 toStoredAnswer 去重不产出 BB', () => {
    const dupOpts = [
      { label: 'A', text: '甲', isCorrect: false },
      { label: 'B', text: '乙', isCorrect: true },
      { label: 'B', text: '丙', isCorrect: true },
    ];
    expect(variationRejectionReason(
      { content: 'x', answer: 'B', explanation: '', difficulty: 2, variationType: '换数', options: dupOpts },
      'multi_choice',
    )).toContain('label 重复');
    expect(toStoredAnswer(
      { content: 'x', answer: 'B', explanation: '', difficulty: 2, variationType: '换数', options: dupOpts },
      'multi_choice',
    )).toBe('B');
  });

  it('选项 label 重复 -> 拒绝（choice）', () => {
    expect(variationRejectionReason(
      { content: 'x', answer: 'A', explanation: '', difficulty: 2, variationType: '换数', options: [
        { label: 'A', text: '甲', isCorrect: true },
        { label: 'A', text: '乙', isCorrect: false },
      ] },
      'choice',
    )).toContain('label 重复');
  });

  it('无正确项时 toStoredAnswer 回落原 answer（不产出空串）', () => {
    expect(toStoredAnswer(
      { content: 'x', answer: 'AB', explanation: '', difficulty: 2, variationType: '换数', options: opts.map((o) => ({ ...o, isCorrect: false })) },
      'multi_choice',
    )).toBe('AB');
  });
});

describe('既有题型不受影响', () => {
  it('choice 仍归一到唯一正确项 label', () => {
    expect(toStoredAnswer(
      { content: 'x', answer: '乙', explanation: '', difficulty: 2, variationType: '换数', options: [
        { label: 'A', text: '甲', isCorrect: false },
        { label: 'B', text: '乙', isCorrect: true },
      ] },
      'choice',
    )).toBe('B');
  });

  it('非 choice 原样透传，且不做 options 校验', () => {
    expect(toStoredAnswer(
      { content: 'x', answer: '3.5', explanation: '', difficulty: 2, variationType: '换数' }, 'fill_blank',
    )).toBe('3.5');
    expect(variationRejectionReason(
      { content: 'x', answer: '3.5', explanation: '', difficulty: 2, variationType: '换数' }, 'fill_blank',
    )).toBeNull();
  });
});
