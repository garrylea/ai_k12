import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ResearchAuditPage from '../ResearchAuditPage';
import { listResearchAudit, type AuditItem, type ResearchAuditListResult } from '@/services/api';

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
        // 日期选择器的 to 补到当天最后一毫秒，否则漏掉结束日全天。
        to: new Date('2026-11-19T23:59:59.999').toISOString(),
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
    expect(await screen.findByTestId('audit-error')).toHaveTextContent('服务异常');
  });
});

describe('ResearchAuditPage 竞态与重新加载反馈', () => {
  it('旧请求最后返回时不覆盖最新请求的表格数据', async () => {
    const first = deferred<ResearchAuditListResult>();
    const second = deferred<ResearchAuditListResult>();
    listMock.mockReset()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    renderPage();
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('audit-filter-action'), { target: { value: 'image.delete' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));

    // 新请求先到达
    await act(async () => {
      second.resolve({
        items: [item({ id: 2, actorName: '最新操作人', note: '最新记录' })],
        total: 1, page: 1, pageSize: 20,
      });
    });
    expect(await screen.findByText('最新记录')).toBeInTheDocument();

    // 旧请求后到达，必须被忽略
    await act(async () => {
      first.resolve({
        items: [item({ id: 1, actorName: '过期操作人', note: '过期记录' })],
        total: 1, page: 1, pageSize: 20,
      });
    });
    expect(screen.queryByText('过期记录')).not.toBeInTheDocument();
    expect(screen.getByText('最新记录')).toBeInTheDocument();
  });

  it('换筛选重新拉取期间展示骨架，不再停留在旧表格', async () => {
    const pending = deferred<ResearchAuditListResult>();
    listMock.mockReset()
      .mockResolvedValueOnce({ items: [item({ id: 1, note: '旧记录' })], total: 1, page: 1, pageSize: 20 })
      .mockReturnValueOnce(pending.promise);

    renderPage();
    expect(await screen.findByText('旧记录')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('audit-filter-action'), { target: { value: 'image.delete' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));

    expect(await screen.findByTestId('audit-loading')).toBeInTheDocument();
    expect(screen.queryByText('旧记录')).not.toBeInTheDocument();

    await act(async () => {
      pending.resolve({
        items: [item({ id: 2, note: '新记录' })],
        total: 1, page: 1, pageSize: 20,
      });
    });
    expect(await screen.findByText('新记录')).toBeInTheDocument();
    expect(screen.queryByTestId('audit-loading')).not.toBeInTheDocument();
  });
});
