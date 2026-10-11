import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AnalyticsModulesPage from './AnalyticsModulesPage';
import { getAdminModules, getAdminApiUsage, type ModulesData, type ApiUsageData } from '@/services/api';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getAdminModules: vi.fn(), getAdminApiUsage: vi.fn() };
});

const getModulesMock = vi.mocked(getAdminModules);
const getApiUsageMock = vi.mocked(getAdminApiUsage);

afterEach(() => cleanup());

const DATA: ModulesData = {
  items: [
    {
      module: 'mainline', students: 3, seconds: 7200, answered: 40, correct: 30, accuracy: 0.75,
      llmCalls: 12, llmInputTokens: 48000, llmOutputTokens: 9600,
    },
    {
      module: 'en_vocabulary', students: 2, seconds: 600, answered: 20, correct: 20, accuracy: 1,
      llmCalls: 0, llmInputTokens: 0, llmOutputTokens: 0,
    },
  ],
};

const API_USAGE: ApiUsageData = {
  items: [
    { module: 'practice', calls: 10, failedCalls: 2, failureRate: 0.2, avgLatencyMs: 124 },
    { module: null, calls: 3, failedCalls: 0, failureRate: 0, avgLatencyMs: null },
  ],
};

describe('AnalyticsModulesPage', () => {
  it('渲染模块表：中文模块名、时长、正确率、LLM 三列（0 显示 0）', async () => {
    getModulesMock.mockResolvedValue(DATA);
    getApiUsageMock.mockResolvedValue({ items: [] });

    render(
      <MemoryRouter>
        <AnalyticsModulesPage />
      </MemoryRouter>,
    );

    const row = await screen.findByTestId('module-row-mainline');
    expect(row.textContent).toContain('主线');
    expect(row.textContent).toContain('2 小时 0 分');
    expect(row.textContent).toContain('75%');
    expect(row.textContent).toContain('48000');
    expect(screen.getByTestId('module-row-en_vocabulary').textContent).toContain('背单词');
    // LLM 三列：0 是真实 0，照常显示
    expect(screen.getByTestId('module-row-en_vocabulary').textContent).toContain('0');
  });

  it('底部「各模块 API 调用」表：中文映射、失败率、平均耗时、NULL 模块 → 后台任务', async () => {
    getModulesMock.mockResolvedValue(DATA);
    getApiUsageMock.mockResolvedValue(API_USAGE);

    render(
      <MemoryRouter>
        <AnalyticsModulesPage />
      </MemoryRouter>,
    );

    const row = await screen.findByTestId('api-usage-row-practice');
    expect(row.textContent).toContain('主线课堂');
    expect(row.textContent).toContain('10');
    expect(row.textContent).toContain('20%');
    expect(row.textContent).toContain('124 ms');
    const nullRow = screen.getByTestId('api-usage-row-null');
    expect(nullRow.textContent).toContain('后台任务');
    expect(nullRow.textContent).toContain('—'); // avgLatencyMs null → '—'
  });

  it('items 为空 → 「暂无数据」行（禁「不足 1 分钟」类反向误读）', async () => {
    getModulesMock.mockResolvedValue({ items: [] });
    getApiUsageMock.mockResolvedValue({ items: [] });

    render(
      <MemoryRouter>
        <AnalyticsModulesPage />
      </MemoryRouter>,
    );

    // 两张表都空 → 两行「暂无数据」
    const empties = await screen.findAllByText('暂无数据');
    expect(empties.length).toBe(2);
    expect(screen.queryByText(/不足/)).toBeNull();
    expect(screen.queryByTestId('module-row-mainline')).toBeNull();
  });
});
