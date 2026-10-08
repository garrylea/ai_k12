// apps/web/src/pages/dev/HandwritingDemoPage.test.tsx
import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { forwardRef, useImperativeHandle } from 'react';

vi.mock('@/services/api', () => ({
  listHandwritingModels: vi.fn(),
  recognizeHandwriting: vi.fn(),
}));

import {
  listHandwritingModels,
  recognizeHandwriting,
} from '@/services/api';
import HandwritingDemoPage from './HandwritingDemoPage';

const MODELS = { models: [{ key: 'qwen-test', provider: 'qwen', modelId: 'qwen3.8-max' }] };

// mock 面板：exportImage 可控，另给一个「写入笔画」按钮驱动 onStrokesChange
let exportValue: string | null = null;
const MockPad = forwardRef(function MockPad(
  { onStrokesChange }: { onStrokesChange?: (count: number) => void },
  ref,
) {
  useImperativeHandle(ref, () => ({
    exportImage: () => exportValue,
    clear: () => { exportValue = null; },
  }));
  return (
    <button
      type="button"
      data-testid="mock-stroke"
      onClick={() => { exportValue = 'data:image/png;base64,AAA'; onStrokesChange?.(1); }}
    >
      stroke
    </button>
  );
});
// getter 延迟取 MockPad：vi.mock 工厂被提升到 const MockPad 初始化之前，直接引用会报 TDZ 错
vi.mock('./DemoSketchPad', () => ({ get default() { return MockPad; } }));

beforeEach(() => {
  vi.clearAllMocks();
  exportValue = null;
  vi.mocked(listHandwritingModels).mockResolvedValue(MODELS);
});

afterEach(() => cleanup());

function setup() {
  render(<HandwritingDemoPage />);
  return {
    strokeBtn: screen.getByTestId('mock-stroke'),
    pad: screen.getByTestId('mock-stroke'),
  };
}

it('加载模型下拉并默认选第一个；初始识别按钮禁用（无笔画或无对照文本）', async () => {
  setup();
  await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('qwen-test'));
  const btn = screen.getByRole('button', { name: '识别' });
  expect(btn).toBeDisabled();
  // 写入笔画后仍缺对照文本 → 仍禁用
  fireEvent.click(screen.getByTestId('mock-stroke'));
  expect(btn).toBeDisabled();
});

it('完整一轮：填对照 → 识别 → 展示准确率与错字清单', async () => {
  vi.mocked(recognizeHandwriting).mockResolvedValue({ text: '今天田气很好', modelKey: 'qwen-test', elapsedMs: 123 });
  setup();
  await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('qwen-test'));
  fireEvent.click(screen.getByTestId('mock-stroke'));
  fireEvent.change(screen.getByLabelText('对照文本'), { target: { value: '今天天气很好' } });
  const btn = screen.getByRole('button', { name: '识别' });
  expect(btn).not.toBeDisabled();
  fireEvent.click(btn);
  await waitFor(() => expect(screen.getByText(/本轮字级准确率/)).toBeTruthy());
  expect(recognizeHandwriting).toHaveBeenCalledWith('data:image/png;base64,AAA', 'qwen-test');
  expect(screen.getByText('天 → 田')).toBeTruthy(); // 错字清单出现错字
  // 累计 = Σ本轮命中 ÷ Σ本轮对照字数：「今天天气很好」6 字，识别「今天田气很好」命中 5 → 5/6 = 83.3%
  expect(screen.getByText('累计字级准确率：83.3%（1 轮，5/6 字）')).toBeTruthy();
});

it('累计口径为 Σ（Σmatched ÷ ΣexpectedLen），不做拼接重算', async () => {
  // 第 1 轮：「今天」识别「今」→ 命中 1/2；第 2 轮：「天」识别「天天」→ 命中 1/1（多识别一个「天」）
  vi.mocked(recognizeHandwriting)
    .mockResolvedValueOnce({ text: '今', modelKey: 'qwen-test', elapsedMs: 1 })
    .mockResolvedValueOnce({ text: '天天', modelKey: 'qwen-test', elapsedMs: 2 });
  setup();
  await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('qwen-test'));
  fireEvent.click(screen.getByTestId('mock-stroke'));
  const input = screen.getByLabelText('对照文本');
  const btn = screen.getByRole('button', { name: '识别' });

  fireEvent.change(input, { target: { value: '今天' } });
  fireEvent.click(btn);
  await waitFor(() => expect(screen.getByText(/累计/)).toBeTruthy());

  fireEvent.change(input, { target: { value: '天' } });
  fireEvent.click(btn);
  // Σ = (1+1)/(2+1) = 2/3 = 66.7%；拼接重算会得 LCS(今天天, 今天天)=3/3=100%，此处钉死 Σ 口径
  await waitFor(() => expect(screen.getByText('累计字级准确率：66.7%（2 轮，2/3 字）')).toBeTruthy());
});

it('识别失败 → 显示错误信息，按钮恢复可用', async () => {
  vi.mocked(recognizeHandwriting).mockRejectedValue(new Error('识别模型调用失败：boom'));
  setup();
  await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy());
  fireEvent.click(screen.getByTestId('mock-stroke'));
  fireEvent.change(screen.getByLabelText('对照文本'), { target: { value: '测试' } });
  fireEvent.click(screen.getByRole('button', { name: '识别' }));
  await waitFor(() => expect(screen.getByText(/boom/)).toBeTruthy());
  expect(screen.getByRole('button', { name: '识别' })).not.toBeDisabled();
});
