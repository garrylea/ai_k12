// 点图放大：点击缩略图在当前页打开浮层（触屏同样可用），Esc / 点背景关闭。
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MarkdownImg } from './markdown';

afterEach(() => cleanup());

describe('MarkdownImg 点击放大', () => {
  it('点图打开浮层，点背景关闭', () => {
    render(<MarkdownImg src="questions/physics/x/1/stem_01.jpg" alt="图" />);
    fireEvent.click(screen.getByRole('img'));
    expect(screen.getByRole('dialog', { name: '放大图片' })).toBeTruthy();
    fireEvent.click(screen.getByRole('dialog', { name: '放大图片' }));
    expect(screen.queryByRole('dialog', { name: '放大图片' })).toBeNull();
  });

  it('Esc 关闭浮层', () => {
    render(<MarkdownImg src="questions/physics/x/1/stem_01.jpg" alt="图" />);
    fireEvent.click(screen.getByRole('img'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '放大图片' })).toBeNull();
  });

  it('zoomable=false 时不响应点击', () => {
    render(<MarkdownImg src="questions/physics/x/1/stem_01.jpg" alt="图" zoomable={false} />);
    fireEvent.click(screen.getByRole('img'));
    expect(screen.queryByRole('dialog', { name: '放大图片' })).toBeNull();
  });
});
