import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AnalyticsQualityPage from './AnalyticsQualityPage';
import { getAdminQuality, type QualityData } from '@/services/api';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getAdminQuality: vi.fn() };
});

const getQualityMock = vi.mocked(getAdminQuality);

afterEach(() => cleanup());

const DATA: QualityData = {
  apiFailureRate: 0.02,
  errorCodeDistribution: [{ code: 1001, count: 12 }],
  llmTimeoutRate: 0.05,
  llmFallbackRate: 0.1,
  llmAttributionCoverage: 0.95,
  questionsWithoutStandardAnswer: 4,
  kpCoverage: { covered: 90, total: 100, rate: 0.9 },
  globalWordErrorRate: { wrong: 8, total: 200, rate: 0.04 },
  passageSkipRate: null,
};

describe('AnalyticsQualityPage', () => {
  it('渲染四张比率卡 + 错误码分布 + 内容四指标（passageSkipRate 恒 —）', async () => {
    getQualityMock.mockResolvedValue(DATA);

    render(
      <MemoryRouter>
        <AnalyticsQualityPage />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('card-API 失败率')).toHaveTextContent('2%');
    expect(screen.getByTestId('card-LLM 超时率')).toHaveTextContent('5%');
    expect(screen.getByTestId('card-LLM 降级率')).toHaveTextContent('10%');
    expect(screen.getByTestId('card-归因覆盖率')).toHaveTextContent('95%');

    expect(screen.getByTestId('error-code-row-1001').textContent).toContain('12');

    expect(screen.getByTestId('content-知识点覆盖率')).toHaveTextContent('90%');
    expect(screen.getByTestId('content-全局错词率')).toHaveTextContent('4%');
    expect(screen.getByTestId('content-课文跳过率')).toHaveTextContent('—');
    expect(screen.getByTestId('content-缺标准答案题数')).toHaveTextContent('4');
  });
});
