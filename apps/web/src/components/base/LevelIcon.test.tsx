import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { LevelIcon } from './LevelIcon';

afterEach(() => cleanup());

const LEVEL_CODES = [
  'pichai',
  'zhutie',
  'qingtong',
  'baiyin',
  'huangjin',
  'bojin',
  'zuanshi',
  'xingyao',
  'wangzhe',
] as const;

describe('LevelIcon', () => {
  it('9 个段位 code 都能渲染出 svg', () => {
    for (const code of LEVEL_CODES) {
      const { container, unmount } = render(<LevelIcon code={code} />);
      expect(container.querySelector('svg')).toBeInTheDocument();
      unmount();
    }
  });

  it('9 个段位的图形各不相同', () => {
    const markups = LEVEL_CODES.map((code) => {
      const { container, unmount } = render(<LevelIcon code={code} />);
      const markup = container.querySelector('svg')?.innerHTML ?? '';
      unmount();
      return markup;
    });
    expect(new Set(markups).size).toBe(LEVEL_CODES.length);
    expect(markups.every((m) => m.length > 0)).toBe(true);
  });

  it('未知 code 不抛错，且回退渲染 pichai 图形', () => {
    const unknown = render(<LevelIcon code="nope" />);
    const unknownMarkup = unknown.container.querySelector('svg')?.innerHTML;
    unknown.unmount();

    const fallback = render(<LevelIcon code="pichai" />);
    const fallbackMarkup = fallback.container.querySelector('svg')?.innerHTML;
    fallback.unmount();

    expect(unknownMarkup).toBe(fallbackMarkup);
    expect(unknownMarkup).toBeTruthy();
  });

  it('size 默认 24，传入 size=96 时生效', () => {
    const { container, unmount } = render(<LevelIcon code="zhutie" />);
    const defaultSvg = container.querySelector('svg');
    expect(defaultSvg).toHaveAttribute('width', '24');
    expect(defaultSvg).toHaveAttribute('height', '24');
    unmount();

    const large = render(<LevelIcon code="zhutie" size={96} />);
    const largeSvg = large.container.querySelector('svg');
    expect(largeSvg).toHaveAttribute('width', '96');
    expect(largeSvg).toHaveAttribute('height', '96');
  });

  it('className 透传到 svg 元素上', () => {
    const { container } = render(<LevelIcon code="wangzhe" className="w-8 text-[var(--brand-600)]" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveClass('w-8');
    expect(svg).toHaveClass('text-[var(--brand-600)]');
  });

  it('统一使用 currentColor 线性描边，不写死颜色', () => {
    const { container } = render(<LevelIcon code="bojin" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
    expect(svg).toHaveAttribute('fill', 'none');
    expect(svg).toHaveAttribute('stroke', 'currentColor');
    expect(svg?.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,6}|rgb\(/);
  });
});
