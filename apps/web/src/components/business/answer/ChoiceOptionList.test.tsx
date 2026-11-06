import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChoiceOptionList } from './ChoiceOptionList';

afterEach(() => cleanup());

const TF = [
  { label: '对', text: '对' },
  { label: '错', text: '错' },
];

describe('ChoiceOptionList 判断题', () => {
  it('只用绿勾/红叉表达，不再重复写「对/错」文字', () => {
    render(<ChoiceOptionList options={TF} value="" onChange={() => {}} trueFalse />);

    // 两个可选项，各有可读的 aria-label（视觉上是图标）
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(['对', '错']);
    // 页面上不应再出现「对/错」文字（此前 label 圆点 + 选项正文各写一次）
    expect(screen.queryByText('对')).toBeNull();
    expect(screen.queryByText('错')).toBeNull();
    // 图标是线性 SVG，不是 emoji
    expect(radios[0].querySelector('svg')).toBeTruthy();
    expect(radios[1].querySelector('svg')).toBeTruthy();
    expect(screen.queryByText('✓')).toBeNull();
    expect(screen.queryByText('✗')).toBeNull();
  });

  it('点选提交「对/错」标签并回报选中态', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ChoiceOptionList options={TF} value="" onChange={onChange} trueFalse />,
    );
    fireEvent.click(screen.getByRole('radio', { name: '对' }));
    expect(onChange).toHaveBeenCalledWith('对');

    rerender(<ChoiceOptionList options={TF} value="对" onChange={onChange} trueFalse />);
    expect(screen.getByRole('radio', { name: '对' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: '错' }).getAttribute('aria-checked')).toBe('false');
  });
});

describe('ChoiceOptionList 普通选择题', () => {
  it('仍按「标签 + 选项正文」渲染', () => {
    render(
      <ChoiceOptionList
        options={[{ label: 'A', text: '选项甲' }, { label: 'B', text: '选项乙' }]}
        value=""
        onChange={() => {}}
      />,
    );
    expect(screen.getByText('A')).toBeTruthy();
    expect(screen.getByText('选项甲')).toBeTruthy();
  });
});
