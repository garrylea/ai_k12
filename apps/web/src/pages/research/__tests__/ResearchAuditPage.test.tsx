import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ResearchAuditPage from '../ResearchAuditPage';
import { listResearchAudit, type AuditItem } from '@/services/api';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, listResearchAudit: vi.fn() };
});

const listMock = vi.mocked(listResearchAudit);

function item(over: Partial<AuditItem> = {}): AuditItem {
  return {
    id: 1,
    actorId: 7,
    actorRole: 'researcher',
    actorName: '教研员',
    action: 'question.update',
    targetType: 'question',
    targetId: 9,
    paperId: 12,
    beforeJson: { answer: 'D' },
    afterJson: { answer: 'C' },
    note: '更正答案',
    createdAt: '2026-11-19T00:00:00.000Z',
    ...over,
  };
}

function renderPage() {
  return render(<ResearchAuditPage />);
}

beforeEach(() => {
  listMock.mockReset().mockResolvedValue({ items: [item()], total: 1, page: 1, pageSize: 20 });
});

afterEach(() => {
  cleanup();
});

describe('ResearchAuditPage 审计日志渲染', () => {
  it('按 action 筛选并展示改前改后', async () => {
    renderPage();

    expect(await screen.findByText('question.update')).toBeInTheDocument();
    const pres = screen.getAllByText(/answer/);
    expect(pres).toHaveLength(2);
    expect(pres[0].tagName).toBe('PRE');
    expect(pres[0]).toHaveTextContent('"answer": "D"');
    expect(pres[1]).toHaveTextContent('"answer": "C"');
  });

  it('表格含时间/操作人/动作/对象/改前/改后/备注七列及数据', async () => {
    renderPage();

    const table = await screen.findByTestId('audit-table');
    for (const name of ['时间', '操作人', '动作', '对象', '改前', '改后', '备注']) {
      expect(table).toHaveTextContent(name);
    }
    expect(table).toHaveTextContent('教研员');
    expect(table).toHaveTextContent('question #9');
    expect(table).toHaveTextContent('更正答案');
  });

  it('beforeJson/afterJson 非对象时也按 JSON.stringify 原样渲染', async () => {
    listMock.mockResolvedValueOnce({
      items: [item({ beforeJson: null, afterJson: '已删除' })],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    renderPage();

    const table = await screen.findByTestId('audit-table');
    expect(table).toHaveTextContent('null');
    expect(table).toHaveTextContent('"已删除"');
  });
});

describe('ResearchAuditPage 筛选与分页', () => {
  it('换筛选回第 1 页并把全部筛选条件传给 API', async () => {
    listMock.mockResolvedValue({ items: [item()], total: 100, page: 1, pageSize: 20 });

    renderPage();
    await screen.findByTestId('audit-table');

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(listMock).toHaveBeenLastCalledWith({ page: 2, pageSize: 20 }));
    expect(screen.getByText('第 2 / 5 页')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('audit-filter-action'), { target: { value: 'paper.delete' } });
    fireEvent.change(screen.getByTestId('audit-filter-target-type'), { target: { value: 'paper' } });
    fireEvent.change(screen.getByTestId('audit-filter-actor'), { target: { value: '7' } });
    fireEvent.change(screen.getByTestId('audit-filter-from'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByTestId('audit-filter-to'), { target: { value: '2026-11-19' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));

    await waitFor(() => {
      expect(listMock).toHaveBeenLastCalledWith({
        action: 'paper.delete',
        targetType: 'paper',
        actorId: 7,
        from: '2026-11-01',
        to: '2026-11-19',
        page: 1,
        pageSize: 20,
      });
    });
  });

  it('首屏不带筛选条件，page=1/pageSize=20', async () => {
    renderPage();
    await screen.findByTestId('audit-table');
    expect(listMock).toHaveBeenCalledWith({ page: 1, pageSize: 20 });
  });

  it('空数据展示空态，失败展示错误态', async () => {
    listMock.mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 20 });
    const { unmount } = renderPage();
    expect(await screen.findByTestId('audit-empty')).toBeInTheDocument();
    unmount();

    listMock.mockRejectedValueOnce(new Error('服务异常'));
    renderPage();
    expect(await screen.findByTestId('audit-error')).toBeInTheDocument();
  });
});
