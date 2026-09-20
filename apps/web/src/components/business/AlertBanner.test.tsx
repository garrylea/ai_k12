import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router-dom';
import AlertBanner, { ALERT_POLL_INTERVAL_MS } from './AlertBanner';
import {
  getParentUnreadAlerts,
  markParentAlertRead,
  type ParentUnreadAlerts,
} from '@/services/api';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    getParentUnreadAlerts: vi.fn(),
    markParentAlertRead: vi.fn().mockResolvedValue(null),
  };
});

const getParentUnreadAlertsMock = vi.mocked(getParentUnreadAlerts);
const markParentAlertReadMock = vi.mocked(markParentAlertRead);

function unread(over: Partial<ParentUnreadAlerts> = {}): ParentUnreadAlerts {
  return {
    items: [
      {
        id: 26,
        type: 'idle',
        level: 'info',
        message: '孩子在学习页面 5 分钟无操作',
        studentName: '小刚',
        createdAt: '2026-09-20T19:26:27.728Z',
      },
    ],
    total: 1,
    ...over,
  };
}

function renderBanner() {
  const router = createMemoryRouter(
    [
      {
        path: '/parent',
        element: (
          <>
            <AlertBanner />
            <Outlet />
          </>
        ),
        children: [{ path: 'alerts', element: <div>预警中心页</div> }],
      },
    ],
    { initialEntries: ['/parent'] },
  );
  return render(<RouterProvider router={router} />);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  getParentUnreadAlertsMock.mockReset().mockResolvedValue(unread());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AlertBanner', () => {
  it('有未读 → 渲染 Banner（info 走神 → warning 橙色档，标题=消息本身）', async () => {
    renderBanner();
    expect(await screen.findByText('孩子在学习页面 5 分钟无操作')).toBeInTheDocument();
  });

  it('多条未读 → 聚合标题「有 N 条新预警，最新：…」', async () => {
    getParentUnreadAlertsMock.mockResolvedValue(
      unread({
        items: [
          { id: 27, type: 'idle', level: 'info', message: 'B 消息', studentName: null, createdAt: '2026-09-20T19:30:00Z' },
          { id: 26, type: 'idle', level: 'info', message: 'A 消息', studentName: '小刚', createdAt: '2026-09-20T19:26:27Z' },
        ],
        total: 7,
      }),
    );
    renderBanner();
    expect(await screen.findByText('有 7 条新预警，最新：B 消息')).toBeInTheDocument();
  });

  it('最新一条是 warning/critical → Banner 用 danger 档（红色）', async () => {
    getParentUnreadAlertsMock.mockResolvedValue(
      unread({
        items: [{ id: 1, type: 'off_topic', level: 'warning', message: '闲聊预警', studentName: '小刚', createdAt: '2026-09-20T19:00:00Z' }],
        total: 1,
      }),
    );
    renderBanner();
    await screen.findByText('闲聊预警');
    // danger 档的类名来自 base Banner 的 typeStyles
    expect(document.querySelector('.bg-\\[var\\(--error\\)\\]')).not.toBeNull();
  });

  it('无未读 / 请求失败 → 不渲染任何东西', async () => {
    getParentUnreadAlertsMock.mockResolvedValue({ items: [], total: 0 });
    const { container } = renderBanner();
    await waitFor(() => expect(getParentUnreadAlertsMock).toHaveBeenCalledTimes(1));
    expect(container.querySelector('button')).toBeNull();

    getParentUnreadAlertsMock.mockRejectedValue(new Error('net'));
    await vi.advanceTimersByTimeAsync(ALERT_POLL_INTERVAL_MS);
    expect(container.querySelector('button')).toBeNull();
  });

  it('每 30s 轮询一次', async () => {
    renderBanner();
    await waitFor(() => expect(getParentUnreadAlertsMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(ALERT_POLL_INTERVAL_MS);
    expect(getParentUnreadAlertsMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(ALERT_POLL_INTERVAL_MS);
    expect(getParentUnreadAlertsMock).toHaveBeenCalledTimes(3);
  });

  it('点击「立即查看」→ 对每条未读发标已读、清掉 Banner、跳 /parent/alerts', async () => {
    getParentUnreadAlertsMock
      .mockResolvedValueOnce(
        unread({
          items: [
            { id: 27, type: 'idle', level: 'info', message: 'B', studentName: null, createdAt: '2026-09-20T19:30:00Z' },
            { id: 26, type: 'idle', level: 'info', message: 'A', studentName: null, createdAt: '2026-09-20T19:26:27Z' },
          ],
          total: 2,
        }),
      )
      .mockResolvedValue({ items: [], total: 0 });
    renderBanner();
    const button = await screen.findByRole('button', { name: '立即查看' });
    fireEvent.click(button);

    await waitFor(() => expect(markParentAlertReadMock).toHaveBeenCalledTimes(2));
    expect(markParentAlertReadMock).toHaveBeenCalledWith(26);
    expect(markParentAlertReadMock).toHaveBeenCalledWith(27);
    expect(screen.queryByRole('button', { name: '立即查看' })).toBeNull();
    await waitFor(() => expect(screen.getByText('预警中心页')).toBeInTheDocument());
  });

  it('标已读请求失败 → 静默（仍跳转，下次轮询可能再出现）', async () => {
    markParentAlertReadMock.mockRejectedValue(new Error('net'));
    getParentUnreadAlertsMock.mockResolvedValueOnce(unread()).mockResolvedValue({ items: [], total: 0 });
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: '立即查看' }));
    await waitFor(() => expect(screen.getByText('预警中心页')).toBeInTheDocument());
  });
});
