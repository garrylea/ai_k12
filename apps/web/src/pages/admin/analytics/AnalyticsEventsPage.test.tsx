import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AnalyticsEventsPage from './AnalyticsEventsPage';
import { getAdminEvents, type Paged } from '@/services/api';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getAdminEvents: vi.fn() };
});

const getEventsMock = vi.mocked(getAdminEvents);

afterEach(() => cleanup());

const DATA: Paged<Record<string, unknown>> = {
  items: [
    {
      id: 1,
      created_at: '2026-10-10T08:00:00.000Z',
      event: 'answer_submitted',
      tier: 'ops',
      module: 'mainline',
      scene: 'learning',
      student_id: 3,
      ref_type: 'question',
      ref_id: 12,
    },
    {
      id: 2,
      created_at: '2026-10-10T09:00:00.000Z',
      event: 'ai_message_sent',
      tier: 'parent',
      module: null,
      scene: null,
      student_id: null,
      ref_type: null,
      ref_id: null,
    },
  ],
  page: 1,
  pageSize: 20,
  total: 21,
};

describe('AnalyticsEventsPage', () => {
  it('渲染筛选输入 + 分页表格（中文事件名、时间截断、ref 拼接）', async () => {
    getEventsMock.mockResolvedValue(DATA);

    render(
      <MemoryRouter>
        <AnalyticsEventsPage />
      </MemoryRouter>,
    );

    // 筛选输入存在（brief Step 2 断言点）
    expect(screen.getByLabelText('事件筛选')).toBeInTheDocument();
    expect(screen.getByLabelText('模块筛选')).toBeInTheDocument();

    const row1 = await screen.findByTestId('event-row-1');
    expect(row1.textContent).toContain('2026-10-10 08:00:00');
    expect(row1.textContent).toContain('提交作答');
    expect(row1.textContent).toContain('主线');
    expect(row1.textContent).toContain('question:12');

    const row2 = screen.getByTestId('event-row-2');
    expect(row2.textContent).toContain('AI 提问');
    expect(row2.textContent).toContain('—');

    // total 21 / pageSize 20 → 共 2 页；第 1 页「上一页」禁用
    expect(screen.getByTestId('events-pagination').textContent).toContain('第 1 / 2 页');
    expect(screen.getByText('上一页')).toBeDisabled();
    expect(screen.getByText('下一页')).toBeEnabled();
  });
});
