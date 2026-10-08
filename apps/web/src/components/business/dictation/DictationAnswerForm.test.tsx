import { it, expect, afterEach, vi } from 'vitest';
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import type { ForwardedRef } from 'react';
import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { HandwritingTranscribeResult } from '@/services/api';
import { transcribeHandwriting } from '@/services/api';
import DictationAnswerForm, { type DictationAnswerValue } from './DictationAnswerForm';

// 不再整体 mock InlineHandwritingPad：ref 镜像回归用例要走真实 pad 的「识别并追加」异步链路
// （transcribeHandwriting 在途 → 键入 → resolve），因此 mock 底层画板与 API。
vi.mock('@/services/api', () => ({
  transcribeHandwriting: vi.fn(),
}));

/** jsdom 无画布：mock 底层 HandwritingPad——exportImage 恒有图、笔画数恒为 1（识别钮可点、识别后仍可再点）。 */
vi.mock('../HandwritingPad', () => ({
  default: forwardRef(function MockHandwritingPad(
    { onStrokesChange, toolbarRight }: { onStrokesChange?: (count: number) => void; toolbarRight?: React.ReactNode },
    ref: ForwardedRef<{ exportImage: () => string | null; clear: () => void }>,
  ) {
    useImperativeHandle(ref, () => ({
      exportImage: () => 'data:image/png;base64,mock',
      clear: () => {},
    }));
    // 真实 pad 识别成功后会把笔画数清零；这里每次渲染恢复成 1，保持「识别并追加」可点
    useEffect(() => { onStrokesChange?.(1); });
    // toolbarRight 槽承载调用方的「键盘」收起图标，透传渲染保证可查可点
    return <div data-testid="mock-handwriting-board">{toolbarRight}</div>;
  }),
}));

afterEach(() => {
  cleanup();
  vi.mocked(transcribeHandwriting).mockReset();
});

const transcribeResult = (text: string): HandwritingTranscribeResult => ({ text, modelKey: 'mock', elapsedMs: 0 });

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
  const buttons = screen.getAllByRole('button', { name: '切换到手写输入' });
  expect(buttons).toHaveLength(3);
  rerender(<DictationAnswerForm value={{ author: '', dynasty: '', body: '' }} onChange={vi.fn()} disabled />);
  for (const b of screen.getAllByRole('button', { name: '切换到手写输入' })) expect(b).toBeDisabled();
});

it('作者：展开手写板 → 识别直接拼接；再识别一次继续拼接', async () => {
  vi.mocked(transcribeHandwriting).mockResolvedValue(transcribeResult('手写内容'));
  render(<StatefulHost />);
  fireEvent.click(screen.getAllByRole('button', { name: '切换到手写输入' })[0]); // author
  fireEvent.click(screen.getByRole('button', { name: '识别并追加' }));
  expect(await screen.findByDisplayValue('手写内容')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '识别并追加' }));
  expect(await screen.findByDisplayValue('手写内容手写内容')).toBeInTheDocument();
});

it('正文：识别结果按换行规则追加（非空先补 \\n）', async () => {
  vi.mocked(transcribeHandwriting).mockResolvedValue(transcribeResult('手写内容'));
  render(<StatefulHost initialValue={{ author: '', dynasty: '', body: '先天下' }} />);
  const body = () => screen.getByPlaceholderText('默写整篇正文（标点与空格不计）');
  fireEvent.click(screen.getAllByRole('button', { name: '切换到手写输入' })[2]); // body
  fireEvent.click(screen.getByRole('button', { name: '识别并追加' }));
  await waitFor(() => expect(body()).toHaveValue('先天下\n手写内容'));
  fireEvent.click(screen.getByRole('button', { name: '识别并追加' }));
  await waitFor(() => expect(body()).toHaveValue('先天下\n手写内容\n手写内容'));
});

it('展开态：该字段手写钮隐藏、出现收起钮；收起后手写钮恢复', () => {
  render(<StatefulHost />);
  // 展开 author：author 的手写钮消失，只剩朝代、正文两个
  fireEvent.click(screen.getAllByRole('button', { name: '切换到手写输入' })[0]);
  expect(screen.getAllByRole('button', { name: '切换到手写输入' })).toHaveLength(2);
  expect(screen.getByRole('button', { name: '切换到键盘输入' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '切换到键盘输入' }));
  expect(screen.getAllByRole('button', { name: '切换到手写输入' })).toHaveLength(3);
  expect(screen.queryByRole('button', { name: '切换到键盘输入' })).not.toBeInTheDocument();
});

it('互斥：author 展开后点正文的手写钮 → 仅正文的 pad 生效（收起态钮仍在，可切换）', async () => {
  vi.mocked(transcribeHandwriting).mockResolvedValue(transcribeResult('手写内容'));
  render(<StatefulHost />);
  fireEvent.click(screen.getAllByRole('button', { name: '切换到手写输入' })[0]); // author
  // author 展开后其手写钮消失，剩下的第 0 个是 dynasty、第 1 个是 body
  fireEvent.click(screen.getAllByRole('button', { name: '切换到手写输入' })[1]); // body
  fireEvent.click(screen.getByRole('button', { name: '识别并追加' }));
  // 值落到 body（换行规则），author 保持空
  await waitFor(() => expect(screen.getByPlaceholderText('默写整篇正文（标点与空格不计）')).toHaveValue('手写内容'));
  expect(screen.getByPlaceholderText('例如：范仲淹')).toHaveValue('');
});

it('识别在途期间键入：resolve 后键入保留，不被陈旧 value 覆盖（ref 镜像回归）', async () => {
  let promiseResolve!: (v: HandwritingTranscribeResult) => void;
  vi.mocked(transcribeHandwriting).mockImplementation(
    () => new Promise<HandwritingTranscribeResult>((resolve) => { promiseResolve = resolve; }),
  );
  render(<StatefulHost initialValue={{ author: '', dynasty: '', body: '先天下' }} />);
  const body = () => screen.getByPlaceholderText('默写整篇正文（标点与空格不计）');
  fireEvent.click(screen.getAllByRole('button', { name: '切换到手写输入' })[2]); // body
  fireEvent.click(screen.getByRole('button', { name: '识别并追加' }));
  // 识别在途，学生切回键盘继续键入
  fireEvent.change(body(), { target: { value: '先天下XYZ' } });
  expect(body()).toHaveValue('先天下XYZ');
  await act(async () => { promiseResolve(transcribeResult('手写')); });
  // 最终值 = 键入内容 + 识别结果（按 body 的换行追加规则），键入没有被回滚
  expect(body()).toHaveValue('先天下XYZ\n手写');
});
