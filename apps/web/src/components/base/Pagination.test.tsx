import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Pagination } from './Pagination';

afterEach(() => cleanup());

describe('Pagination', () => {
  it('渲染「上一页 / 第 N / M 页 / 下一页」', () => {
    render(<Pagination page={2} totalPages={5} onChange={() => {}} />);

    expect(screen.getByRole('button', { name: '上一页' })).toBeInTheDocument();
    expect(screen.getByText('第 2 / 5 页')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一页' })).toBeInTheDocument();
  });

  it('首页禁用「上一页」，末页禁用「下一页」', () => {
    const { unmount } = render(<Pagination page={1} totalPages={3} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下一页' })).not.toBeDisabled();
    unmount();

    render(<Pagination page={3} totalPages={3} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  });

  it('点击传回目标页码', () => {
    const onChange = vi.fn();
    render(<Pagination page={2} totalPages={5} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(onChange).toHaveBeenCalledWith(3);

    fireEvent.click(screen.getByRole('button', { name: '上一页' }));
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it('只有一页时两侧按钮都禁用', () => {
    render(<Pagination page={1} totalPages={1} onChange={() => {}} />);

    expect(screen.getByText('第 1 / 1 页')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  });
});
