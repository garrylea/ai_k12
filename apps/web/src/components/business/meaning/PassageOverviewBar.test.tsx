import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import PassageOverviewBar from './PassageOverviewBar';

// globals: false —— @testing-library/react 不会自动注册 cleanup，必须自己写
afterEach(() => cleanup());

const SENTENCES = [
  { index: 0, text: '金樽清酒斗十千', terms: [], answerable: true },
  { index: 1, text: '停杯投箸不能食', terms: [], answerable: false },  // 无标准含义，只显示不出题
  { index: 2, text: '拔剑四顾心茫然', terms: [], answerable: true },
];

describe('PassageOverviewBar', () => {
  it('answerable:false 的句子也渲染（含义依赖上下文，全诗都要看得见）', () => {
    render(<PassageOverviewBar sentences={SENTENCES} currentIndex={0} answeredIndexes={new Set()} />);
    expect(screen.getByText('金樽清酒斗十千')).toBeTruthy();
    expect(screen.getByText('停杯投箸不能食')).toBeTruthy();
    expect(screen.getByText('拔剑四顾心茫然')).toBeTruthy();
  });

  it('当前句加粗、已答句置灰', () => {
    const { container } = render(
      <PassageOverviewBar sentences={SENTENCES} currentIndex={0} answeredIndexes={new Set([2])} />,
    );
    const items = Array.from(container.querySelectorAll('li'));
    expect(items[0].className).toContain('font-bold');
    expect(items[0].className).not.toContain('opacity-50');
    expect(items[2].className).toContain('opacity-50');
  });
});
