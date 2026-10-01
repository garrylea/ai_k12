import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MobileAlertsPage from './MobileAlertsPage';

afterEach(cleanup);

vi.mock('@/services/api', () => ({
  getParentAlerts: vi.fn(),
  markParentAlertRead: vi.fn(),
  getUnreadMessageCount: vi.fn(),
}));
import { getUnreadMessageCount, getParentAlerts, markParentAlertRead } from '@/services/api';

// mock 函数跨用例复用：清掉上个用例遗留的 Once 队列与调用记录
beforeEach(() => {
  vi.clearAllMocks();
});

// total: 25（pageSize 20）→ 共 2 页，「下一页」可点；原 brief 写 total: 2 时只有 1 页、按钮 disabled。
const page1 = {
  items: [
    { id: 11, studentId: 1, studentName: '小明', type: 'off_topic', level: 'warning',
      message: '连续 3 次发起闲聊', context: null, dialogueId: null, isRead: false, createdAt: '2026-10-01T09:00:00Z' },
  ],
  page: 1, pageSize: 20, total: 25,
};
const page2 = { items: [], page: 2, pageSize: 20, total: 25 };

describe('MobileAlertsPage', () => {
  it('渲染预警列表与未读消息数', async () => {
    vi.mocked(getParentAlerts).mockResolvedValue(page1 as never);
    vi.mocked(getUnreadMessageCount).mockResolvedValue(3);
    render(<MobileAlertsPage />);
    expect(await screen.findByText(/连续 3 次发起闲聊/)).toBeTruthy();
    expect(await screen.findByText(/3 条未读消息/)).toBeTruthy();
  });

  it('点「知道了」标记已读并从列表消失', async () => {
    vi.mocked(getParentAlerts).mockResolvedValue(page1 as never);
    vi.mocked(getUnreadMessageCount).mockResolvedValue(0);
    vi.mocked(markParentAlertRead).mockResolvedValue(null);
    render(<MobileAlertsPage />);
    await screen.findByText(/连续 3 次发起闲聊/);
    await userEvent.click(screen.getByTestId('alert-ack-11'));
    await waitFor(() => expect(screen.queryByText(/连续 3 次发起闲聊/)).toBeNull());
  });

  it('翻页：第 2 页无数据显示空态', async () => {
    vi.mocked(getParentAlerts).mockResolvedValueOnce(page1 as never).mockResolvedValueOnce(page2 as never);
    vi.mocked(getUnreadMessageCount).mockResolvedValue(0);
    render(<MobileAlertsPage />);
    await screen.findByText(/连续 3 次发起闲聊/);
    await userEvent.click(screen.getByTestId('alerts-next'));
    expect(await screen.findByText(/暂无预警/)).toBeTruthy();
    expect(getParentAlerts).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
  });

  it('拉取失败显示错误重试', async () => {
    vi.mocked(getParentAlerts).mockRejectedValue(new Error('x'));
    vi.mocked(getUnreadMessageCount).mockRejectedValue(new Error('x'));
    render(<MobileAlertsPage />);
    expect(await screen.findByTestId('alerts-retry')).toBeTruthy();
  });
});
