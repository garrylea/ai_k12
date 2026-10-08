import { it, expect, afterEach, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import DictationAnswerForm, { type DictationAnswerValue } from './DictationAnswerForm';

vi.mock('../handwriting/InlineHandwritingPad', () => ({
  default: ({ open, onRecognized, onClose }: { open: boolean; onRecognized: (t: string) => void; onClose: () => void }) =>
    open ? (
      <div>
        <button type="button" data-testid="mock-pad" onClick={() => onRecognized('手写内容')}>
          mock-pad
        </button>
        <button type="button" data-testid="mock-pad-close" onClick={onClose}>
          mock-pad-close
        </button>
      </div>
    ) : null,
}));

afterEach(() => cleanup());

/**
 * stateful 宿主：value 真实流转（onChange 结果回灌组件），
 * 这样「连续两次识别 = 追加拼接」才能在受控组件上验证。
 */
function StatefulHost({
  initialValue = { author: '', dynasty: '', body: '' },
  disabled = false,
}: {
  initialValue?: DictationAnswerValue;
  disabled?: boolean;
}) {
  const [value, setValue] = useState<DictationAnswerValue>(initialValue);
  return <DictationAnswerForm value={value} onChange={setValue} disabled={disabled} />;
}

it('三个字段各有一个「手写」按钮，disabled 联动输入框', () => {
  const { rerender } = render(<DictationAnswerForm value={{ author: '', dynasty: '', body: '' }} onChange={vi.fn()} />);
  const buttons = screen.getAllByRole('button', { name: '手写' });
  expect(buttons).toHaveLength(3);
  rerender(<DictationAnswerForm value={{ author: '', dynasty: '', body: '' }} onChange={vi.fn()} disabled />);
  for (const b of screen.getAllByRole('button', { name: '手写' })) expect(b).toBeDisabled();
});

it('作者：展开手写板 → 识别直接拼接；再识别一次继续拼接', () => {
  render(<StatefulHost />);
  fireEvent.click(screen.getAllByRole('button', { name: '手写' })[0]); // author
  fireEvent.click(screen.getByTestId('mock-pad'));
  expect(screen.getByDisplayValue('手写内容')).toBeInTheDocument();
  fireEvent.click(screen.getByTestId('mock-pad'));
  expect(screen.getByDisplayValue('手写内容手写内容')).toBeInTheDocument();
});

it('正文：识别结果按换行规则追加（非空先补 \\n）', () => {
  render(<StatefulHost initialValue={{ author: '', dynasty: '', body: '先天下' }} />);
  const body = () => screen.getByPlaceholderText('默写整篇正文（标点与空格不计）');
  fireEvent.click(screen.getAllByRole('button', { name: '手写' })[2]); // body
  fireEvent.click(screen.getByTestId('mock-pad'));
  expect(body()).toHaveValue('先天下\n手写内容');
  fireEvent.click(screen.getByTestId('mock-pad'));
  expect(body()).toHaveValue('先天下\n手写内容\n手写内容');
});

it('展开态：该字段手写钮隐藏、出现收起钮；收起后手写钮恢复', () => {
  render(<StatefulHost />);
  // 展开 author：author 的手写钮消失，只剩朝代、正文两个
  fireEvent.click(screen.getAllByRole('button', { name: '手写' })[0]);
  expect(screen.getAllByRole('button', { name: '手写' })).toHaveLength(2);
  expect(screen.getByTestId('mock-pad-close')).toBeInTheDocument();
  fireEvent.click(screen.getByTestId('mock-pad-close'));
  expect(screen.getAllByRole('button', { name: '手写' })).toHaveLength(3);
  expect(screen.queryByTestId('mock-pad-close')).not.toBeInTheDocument();
});

it('互斥：author 展开后点正文的手写钮 → 仅正文的 pad 生效（收起态钮仍在，可切换）', () => {
  render(<StatefulHost />);
  fireEvent.click(screen.getAllByRole('button', { name: '手写' })[0]); // author
  // author 展开后其手写钮消失，剩下的第 0 个是 dynasty、第 1 个是 body
  fireEvent.click(screen.getAllByRole('button', { name: '手写' })[1]); // body
  fireEvent.click(screen.getByTestId('mock-pad'));
  // 值落到 body（换行规则），author 保持空
  expect(screen.getByDisplayValue('手写内容')).toBeInTheDocument(); // textarea
  expect(screen.getByPlaceholderText('例如：范仲淹')).toHaveValue('');
});
