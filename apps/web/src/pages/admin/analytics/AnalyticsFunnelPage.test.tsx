import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AnalyticsFunnelPage from './AnalyticsFunnelPage';
import { getAdminFunnel, type FunnelData } from '@/services/api';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getAdminFunnel: vi.fn() };
});

const getFunnelMock = vi.mocked(getAdminFunnel);

afterEach(() => cleanup());

const DATA: FunnelData = {
  module: 'mainline',
  steps: [
    { event: 'study_session_started', students: 10 },
    { event: 'answer_submitted', students: 6 },
    { event: 'points_awarded', students: 3 },
  ],
  conversions: [null, 0.6, 0.5],
};

describe('AnalyticsFunnelPage', () => {
  it('默认主线模块；步骤事件显示中文，首步转化 —，后续按百分比', async () => {
    getFunnelMock.mockResolvedValue(DATA);

    render(
      <MemoryRouter>
        <AnalyticsFunnelPage />
      </MemoryRouter>,
    );

    const first = await screen.findByTestId('funnel-step-study_session_started');
    expect(first.textContent).toContain('进入学习');
    expect(first.textContent).toContain('—');
    expect(screen.getByTestId('funnel-step-answer_submitted').textContent).toContain('60%');
    expect(screen.getByTestId('funnel-step-points_awarded').textContent).toContain('50%');

    // 下拉默认主线，选项为中文模块名
    const select = screen.getByLabelText('模块') as HTMLSelectElement;
    expect(select.value).toBe('mainline');
    expect(screen.getByRole('option', { name: '错题练习' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '背单词' })).toBeTruthy();
  });

  it('steps 为空 → 「暂无数据」', async () => {
    getFunnelMock.mockResolvedValue({ ...DATA, steps: [], conversions: [] });

    render(
      <MemoryRouter>
        <AnalyticsFunnelPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('暂无数据')).toBeInTheDocument();
  });
});
