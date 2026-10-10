import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AnalyticsLlmTokensPage from './AnalyticsLlmTokensPage';
import { getAdminLlmTokens, type LlmTokensData } from '@/services/api';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getAdminLlmTokens: vi.fn() };
});

const getTokensMock = vi.mocked(getAdminLlmTokens);

afterEach(() => cleanup());

const DATA: LlmTokensData = {
  groupBy: 'scene',
  items: [
    { key: 'tutor', calls: 30, inputTokens: 12000, outputTokens: 3400, unavailableCalls: 2 },
    { key: 'unknown', calls: 5, inputTokens: 0, outputTokens: 0, unavailableCalls: 5 },
  ],
  attributed: 35,
  unattributed: 3,
  unavailableCalls: 7,
};

describe('AnalyticsLlmTokensPage', () => {
  it('渲染顶部三行汇总（含用量缺失注释）+ 分组明细表', async () => {
    getTokensMock.mockResolvedValue(DATA);

    render(
      <MemoryRouter>
        <AnalyticsLlmTokensPage />
      </MemoryRouter>,
    );

    const summary = await screen.findByTestId('tokens-summary');
    expect(summary.textContent).toContain('归因调用');
    expect(summary.textContent).toContain('35');
    expect(summary.textContent).toContain('未归因调用');
    expect(summary.textContent).toContain('用量缺失不计入 0 求和');
    expect(summary.textContent).toContain('7');

    const tutor = screen.getByTestId('token-row-tutor');
    expect(tutor.textContent).toContain('30');
    expect(tutor.textContent).toContain('12000');
    expect(screen.getByTestId('token-row-unknown').textContent).toContain('5');
  });
});
