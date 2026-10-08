import { it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import DictationAnswerForm, { type DictationAnswerValue } from './DictationAnswerForm';

vi.mock('../handwriting/HandwritingInputModal', () => ({
  default: ({ open, title, onConfirm }: { open: boolean; title: string; onConfirm: (v: string) => void }) =>
    open ? (
      <button type="button" data-testid="mock-pad-confirm" onClick={() => onConfirm('手写内容')}>
        mock-confirm:{title}
      </button>
    ) : null,
}));

afterEach(() => cleanup());

const VALUE: DictationAnswerValue = { author: '', dynasty: '', body: '' };

function setup(overrides: Partial<React.ComponentProps<typeof DictationAnswerForm>> = {}) {
  const onChange = vi.fn();
  const utils = render(<DictationAnswerForm value={VALUE} onChange={onChange} {...overrides} />);
  return { onChange, rerender: utils.rerender };
}

it('三个字段各有一个「手写」按钮，disabled 联动输入框', () => {
  const { rerender } = setup();
  const buttons = screen.getAllByRole('button', { name: '手写' });
  expect(buttons).toHaveLength(3);
  rerender(<DictationAnswerForm value={VALUE} onChange={vi.fn()} disabled />);
  for (const b of screen.getAllByRole('button', { name: '手写' })) expect(b).toBeDisabled();
});

it('点手写 → 弹层确认 → 值回填到对应字段', () => {
  const { onChange } = setup();
  // 作者
  fireEvent.click(screen.getAllByRole('button', { name: '手写' })[0]);
  fireEvent.click(screen.getByTestId('mock-pad-confirm'));
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ author: '手写内容' }));
});
