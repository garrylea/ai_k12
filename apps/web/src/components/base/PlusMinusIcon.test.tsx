import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { PlusMinusIcon } from './PlusMinusIcon';

afterEach(() => cleanup());

describe('PlusMinusIcon', () => {
  it('收起态只有横线（+），展开态多一条竖线（−）', () => {
    const closed = render(<PlusMinusIcon open={false} />);
    const closedPaths = closed.container.querySelectorAll('path').length;
    closed.unmount();

    const open = render(<PlusMinusIcon open />);
    const openPaths = open.container.querySelectorAll('path').length;

    expect(closedPaths).toBe(2);
    expect(openPaths).toBe(1);
  });

  it('size 默认 18（对齐 text-lg），传入 size 时生效', () => {
    const { container, unmount } = render(<PlusMinusIcon open={false} />);
    const defaultSvg = container.querySelector('svg');
    expect(defaultSvg).toHaveAttribute('width', '18');
    expect(defaultSvg).toHaveAttribute('height', '18');
    unmount();

    const sized = render(<PlusMinusIcon open={false} size={24} />);
    expect(sized.container.querySelector('svg')).toHaveAttribute('width', '24');
  });

  it('纯装饰：aria-hidden，不污染外层按钮的可访问名', () => {
    const { container } = render(<PlusMinusIcon open={false} />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('统一使用 currentColor 线性描边，不写死颜色', () => {
    const { container } = render(<PlusMinusIcon open={false} className="text-[var(--text-secondary)]" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
    expect(svg).toHaveAttribute('fill', 'none');
    expect(svg).toHaveAttribute('stroke', 'currentColor');
    expect(svg?.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,6}|rgb\(/);
  });
});
