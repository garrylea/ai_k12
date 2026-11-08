import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { SubjectGlyph } from './SubjectGlyph';
import { TRAINING_SUBJECTS } from '@/subjectConfig';

afterEach(() => cleanup());

/**
 * 回归钉子：训练选科页六张卡曾全部共用一枚哑铃图标，学生只能靠文字分辨学科
 * （2026-11-08 用户发现）。这里锁住「六科图形各不相同」，防止以后又合并成一个。
 */
describe('SubjectGlyph', () => {
  it('六个学科图标都能渲染出 svg，且图形互不相同', () => {
    const markups = TRAINING_SUBJECTS.map((subject) => {
      const { container, unmount } = render(<SubjectGlyph name={subject.icon} />);
      const markup = container.querySelector('svg')?.innerHTML ?? '';
      unmount();
      return markup;
    });

    expect(markups.every((m) => m.length > 0)).toBe(true);
    expect(new Set(markups).size).toBe(TRAINING_SUBJECTS.length);
  });

  it('统一用 currentColor 线性描边，不写死颜色', () => {
    const { container } = render(<SubjectGlyph name="math" />);
    const svg = container.querySelector('svg');

    expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
    expect(svg).toHaveAttribute('fill', 'none');
    expect(svg).toHaveAttribute('stroke', 'currentColor');
    expect(svg).toHaveAttribute('data-subject-icon', 'math');
    expect(svg?.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,6}|rgb\(/);
  });

  it('className 透传到 svg 元素上', () => {
    const { container } = render(<SubjectGlyph name="chemistry" className="w-10 text-white" />);
    const svg = container.querySelector('svg');

    expect(svg).toHaveClass('w-10');
    expect(svg).toHaveClass('text-white');
  });
});
