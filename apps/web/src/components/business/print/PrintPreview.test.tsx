import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PrintPreview } from './PrintPreview';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.classList.remove('print-open');
});

const questions = [{ n: '1', text: '题面' }];

describe('PrintPreview', () => {
  it('open=false 不渲染', () => {
    render(<PrintPreview open={false} questions={questions} onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('打开后显示预览与按钮，Esc 触发 onClose', async () => {
    const onClose = vi.fn();
    render(<PrintPreview open questions={questions} onClose={onClose} />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('button', { name: '导出 PDF' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '关闭' })).toBeTruthy();
    expect(document.body.classList.contains('print-open')).toBe(true);

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('点「导出 PDF」调 window.print', async () => {
    const spy = vi.spyOn(window, 'print').mockImplementation(() => {});
    render(<PrintPreview open questions={questions} onClose={() => {}} />);

    await userEvent.click(screen.getByRole('button', { name: '导出 PDF' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });
});
