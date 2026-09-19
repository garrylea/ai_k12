import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ImageLightbox } from './ImageLightbox';

// globals: false —— 本仓不自动注册 RTL 的 cleanup，多用例文件必须自己收
afterEach(() => cleanup());

describe('ImageLightbox', () => {
  it('渲染原图与关闭按钮（线性 SVG，无 emoji）', () => {
    render(<ImageLightbox src="/uploads/auxiliary/a.jpg" onClose={() => {}} />);

    const box = screen.getByTestId('image-lightbox');
    const img = box.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', '/uploads/auxiliary/a.jpg');

    const closeBtn = screen.getByRole('button', { name: '关闭' });
    expect(closeBtn.querySelector('svg')).not.toBeNull();
  });

  it('点关闭按钮 / 点背景 / 按 Esc 都能关', () => {
    const onClose = vi.fn();
    render(<ImageLightbox src="/uploads/auxiliary/a.jpg" onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    // 点背景（容器自身即 target）
    fireEvent.click(screen.getByTestId('image-lightbox'));
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('点图片本身不关闭（只有背景才关）', () => {
    const onClose = vi.fn();
    render(<ImageLightbox src="/uploads/auxiliary/a.jpg" onClose={onClose} />);

    const img = screen.getByTestId('image-lightbox').querySelector('img')!;
    fireEvent.click(img);

    expect(onClose).not.toHaveBeenCalled();
  });

  it('挂载时锁背景滚动、卸载时复位（漏了会让整页再也滚不动）', () => {
    const { unmount } = render(<ImageLightbox src="/uploads/auxiliary/a.jpg" onClose={() => {}} />);
    expect(document.body.style.overflow).toBe('hidden');

    unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('卸载后 Esc 监听失效（不会对已卸载的组件回调）', () => {
    const onClose = vi.fn();
    const { unmount } = render(<ImageLightbox src="/uploads/auxiliary/a.jpg" onClose={onClose} />);

    unmount();
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
  });
});
