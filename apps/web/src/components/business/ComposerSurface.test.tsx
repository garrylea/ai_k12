import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ComposerSurface } from './ComposerSurface';

/**
 * 答疑 / 做题共用的输入框外观：只钉几何与类，不钉业务。
 * 这两页并排看必须一致，class 一旦各写一份就会漂，所以在这里锁住。
 */
describe('ComposerSurface', () => {
  afterEach(() => cleanup());

  it('附件栏在文本域之前，操作区固定在右下角', () => {
    const { container } = render(
      <ComposerSurface
        preview={<div data-testid="preview">附件</div>}
        actions={<button type="button">发送</button>}
      >
        <textarea aria-label="输入" />
      </ComposerSurface>,
    );

    const shell = container.firstElementChild as HTMLElement;
    expect(shell.className).toContain('rounded-xl');
    expect(shell.className).toContain('bg-[#F9F9FB]');

    // preview 在 textarea 之前
    expect(shell.firstElementChild?.getAttribute('data-testid')).toBe('preview');

    // 操作区绝对定位在右下角
    const actions = screen.getByRole('button', { name: '发送' }).parentElement as HTMLElement;
    expect(actions.className).toContain('absolute');
    expect(actions.className).toContain('right-2');
    expect(actions.className).toContain('bottom-2');
  });

  it('拖入文件时加品牌高亮环', () => {
    const { container } = render(
      <ComposerSurface dragging actions={<button type="button">发送</button>}>
        <textarea aria-label="输入" />
      </ComposerSurface>,
    );

    const shell = container.firstElementChild as HTMLElement;
    expect(shell.className).toContain('ring-2');
    expect(shell.className).toContain('ring-[#FF6B00]');
  });
});
