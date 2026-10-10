import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AnalyticsModulesPage from './AnalyticsModulesPage';
import { getAdminModules, type ModulesData } from '@/services/api';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getAdminModules: vi.fn() };
});

const getModulesMock = vi.mocked(getAdminModules);

afterEach(() => cleanup());

const DATA: ModulesData = {
  items: [
    { module: 'mainline', students: 3, seconds: 7200, answered: 40, correct: 30, accuracy: 0.75 },
    { module: 'en_vocabulary', students: 2, seconds: 600, answered: 20, correct: 20, accuracy: 1 },
  ],
};

describe('AnalyticsModulesPage', () => {
  it('渲染模块表：中文模块名、时长、正确率', async () => {
    getModulesMock.mockResolvedValue(DATA);

    render(
      <MemoryRouter>
        <AnalyticsModulesPage />
      </MemoryRouter>,
    );

    const row = await screen.findByTestId('module-row-mainline');
    expect(row.textContent).toContain('主线');
    expect(row.textContent).toContain('2 小时 0 分');
    expect(row.textContent).toContain('75%');
    expect(screen.getByTestId('module-row-en_vocabulary').textContent).toContain('背单词');
  });

  it('items 为空 → 「暂无数据」行（禁「不足 1 分钟」类反向误读）', async () => {
    getModulesMock.mockResolvedValue({ items: [] });

    render(
      <MemoryRouter>
        <AnalyticsModulesPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('暂无数据')).toBeInTheDocument();
    expect(screen.queryByText(/不足/)).toBeNull();
    expect(screen.queryByTestId('module-row-mainline')).toBeNull();
  });
});
