import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import SpecialsPanel from './SpecialsPanel';
import { getParentSpecials, type ParentSpecials } from '@/services/api';
import { useThemeStore } from '@/store/themeStore';

/** 图表桩：recharts 在 jsdom 里量不到尺寸、不真渲染 SVG（同页面测试的做法）。 */
vi.mock('@/components/business/parent/ChartBar', () => ({
  default: ({ points }: { points: Array<{ label: string; value: number }> }) => (
    <div data-testid="chart-bar" data-count={points.length}>
      {points.map((p) => `${p.label}:${p.value}`).join(',')}
    </div>
  ),
}));

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getParentSpecials: vi.fn() };
});

const getSpecialsMock = vi.mocked(getParentSpecials);

const module = (units: number, correct: number, rate: number | null, byDay: Array<{ date: string; count: number }> = []) =>
  ({ units, correct, rate, byDay });

const SPECIALS: ParentSpecials = {
  dictation: module(3, 2, 66.7, [{ date: '2026-09-15', count: 2 }]),
  interpretation: module(5, 4, 80, [{ date: '2026-09-15', count: 1 }]),
  meaning: module(2, 2, 100, []),
  vocabulary: { ...module(10, 8, 80, [{ date: '2026-09-16', count: 4 }]), newWords: 7 },
};

beforeEach(() => {
  getSpecialsMock.mockReset();
  getSpecialsMock.mockResolvedValue(SPECIALS);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useThemeStore.setState({ mode: 'student-day' });
});

describe('SpecialsPanel', () => {
  it('四个模块都在，units 与 rate 正确显示', async () => {
    render(<SpecialsPanel studentId={11} />);

    const card = await screen.findByTestId('dashboard-special-11');
    for (const label of ['语文默写', '语文解释', '语文含义', '英语背单词']) {
      expect(card.textContent).toContain(label);
    }
    expect(card.textContent).toContain('3 篇');
    expect(card.textContent).toContain('5 句');
    expect(card.textContent).toContain('66.7%');
    expect(getSpecialsMock).toHaveBeenCalledWith(11);
  });

  it('rate=null → 该行显示「暂无数据」，绝不显示 0%', async () => {
    getSpecialsMock.mockResolvedValue({
      ...SPECIALS,
      dictation: module(0, 0, null),
    });
    render(<SpecialsPanel studentId={11} />);

    // 断言必须**限定在该行**：直接查整卡会出现「80%」里含「0%」的假阳性
    const row = await screen.findByTestId('special-row-dictation');
    expect(row.textContent).toContain('暂无数据');
    expect(row.textContent).not.toContain('0%');
  });

  it('newWords 只在英语那行显示（另三个模块不出现「答对 N 词」）', async () => {
    render(<SpecialsPanel studentId={11} />);

    const card = await screen.findByTestId('dashboard-special-11');
    expect(card.textContent).toContain('答对 7 词');
    // 只出现一次
    expect(card.textContent?.match(/答对 \d+ 词/g)).toHaveLength(1);
  });

  it('byDay 四模块合并成每天总数（按日期升序），喂给柱状图', async () => {
    render(<SpecialsPanel studentId={11} />);

    const chart = await screen.findByTestId('chart-bar');
    // 09-15 = 2+1 = 3，09-16 = 4
    expect(chart.textContent).toBe('09-15:3,09-16:4');
  });

  it('取数失败 → 静默降级为「暂无数据」，不抛错、不渲错误卡', async () => {
    getSpecialsMock.mockRejectedValue(new Error('boom'));
    render(<SpecialsPanel studentId={11} />);

    const card = await screen.findByTestId('dashboard-special-11');
    await waitFor(() => expect(card.textContent).toContain('暂无数据'));
    expect(card.textContent).not.toContain('暂时加载失败');
  });

  it('切孩子时请求未回来 → 不残留上一个孩子的数字（防「闪现旧数据」）', async () => {
    const { rerender } = render(<SpecialsPanel studentId={11} />);
    await waitFor(() =>
      expect(screen.getByTestId('dashboard-special-11').textContent).toContain('3 篇'),
    );

    getSpecialsMock.mockImplementation(() => new Promise<ParentSpecials>(() => {}));
    rerender(<SpecialsPanel studentId={12} />);

    const next = screen.getByTestId('dashboard-special-12');
    expect(next.textContent).not.toContain('3 篇');
    expect(next.textContent).toContain('暂无数据');
  });
});
