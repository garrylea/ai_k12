import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import AuxiliaryLayout from './AuxiliaryLayout';

/**
 * 外壳尺寸只有这一处真源：答疑页与做题页必须共用 `max-w-6xl / h-[85vh]`。
 * 做题页不传 sidebar —— 不渲染空 aside，否则内容区会平白窄 256px。
 */
describe('AuxiliaryLayout', () => {
  afterEach(() => cleanup());

  it('传 sidebar 时渲染侧栏与内容区', () => {
    const { container } = render(
      <AuxiliaryLayout sidebar={<div>侧栏</div>}>
        <div>内容</div>
      </AuxiliaryLayout>,
    );

    expect(screen.getByText('侧栏')).toBeTruthy();
    expect(screen.getByText('内容')).toBeTruthy();
    expect(container.querySelector('aside')).not.toBeNull();
  });

  it('不传 sidebar 时只有内容区，外壳尺寸不变', () => {
    const { container } = render(
      <AuxiliaryLayout>
        <div>内容</div>
      </AuxiliaryLayout>,
    );

    expect(container.querySelector('aside')).toBeNull();
    const shell = container.querySelector('.max-w-6xl');
    expect(shell).not.toBeNull();
    expect(shell?.className).toContain('h-[85vh]');
    expect(shell?.textContent).toBe('内容');
  });
});
