import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Tag } from './Tag';

describe('Tag', () => {
  it('渲染 children 文本', () => {
    render(<Tag>易</Tag>);
    expect(screen.getByText('易')).toBeInTheDocument();
  });

  it('不同 variant 应用对应样式类', () => {
    render(<Tag variant="hard">难</Tag>);
    const el = screen.getByText('难');
    expect(el).toHaveClass('bg-red-100');
  });

  it('size=md 应用更大内边距', () => {
    render(<Tag size="md">中等</Tag>);
    expect(screen.getByText('中等')).toHaveClass('px-3');
  });
});
