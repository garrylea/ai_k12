import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PrintIconButton } from './PrintIconButton';

afterEach(() => cleanup());

describe('PrintIconButton', () => {
  it('渲染可访问名称「导出 PDF」并触发点击', async () => {
    const onClick = vi.fn();
    render(<PrintIconButton onClick={onClick} />);
    await userEvent.click(screen.getByRole('button', { name: '导出 PDF' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
