import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MobileMessagesPage from './MobileMessagesPage';

afterEach(cleanup);

vi.mock('@/services/api', () => ({
  listMyMessages: vi.fn(),
  getUnreadMessageCount: vi.fn(),
  markMessageRead: vi.fn(),
}));
import { getUnreadMessageCount, listMyMessages, markMessageRead } from '@/services/api';

const msgs = [
  { id: 1, type: 'broadcast', title: '假期安排', content: '国庆期间照常开放。', isRead: true, isBroadcast: true, createdAt: '2026-10-01T09:00:00Z' },
  { id: 2, type: 'notice', title: '预警提醒', content: '孩子连续 3 次发起闲聊。', isRead: false, isBroadcast: false, createdAt: '2026-10-02T10:00:00Z' },
];

describe('MobileMessagesPage', () => {
  it('渲染消息列表与未读数', async () => {
    vi.mocked(listMyMessages).mockResolvedValue(msgs as never);
    vi.mocked(getUnreadMessageCount).mockResolvedValue(1);
    render(<MobileMessagesPage />);
    expect(await screen.findByText('假期安排')).toBeTruthy();
    expect(screen.getByText(/1 条未读/)).toBeTruthy();
    // 收起态不显示正文
    expect(screen.queryByText('孩子连续 3 次发起闲聊。')).toBeNull();
  });

  it('点条目展开全文并标记已读', async () => {
    vi.mocked(listMyMessages).mockResolvedValue(msgs as never);
    vi.mocked(getUnreadMessageCount).mockResolvedValue(1);
    vi.mocked(markMessageRead).mockResolvedValue(null);
    render(<MobileMessagesPage />);
    await screen.findByText('预警提醒');
    await userEvent.click(screen.getByTestId('msg-item-2'));
    expect(await screen.findByText(/孩子连续 3 次发起闲聊/)).toBeTruthy();
    expect(markMessageRead).toHaveBeenCalledWith(2);
    await waitFor(() => expect(screen.getByTestId('msg-item-2').textContent).toContain('已读'));
  });

  it('展开未读条后立即刷新未读数（不等 30s tick）', async () => {
    vi.mocked(listMyMessages).mockResolvedValue(msgs as never);
    // 首次进页 1 条未读；已读成功后服务端口径变 0
    vi.mocked(getUnreadMessageCount).mockResolvedValueOnce(1).mockResolvedValue(0);
    vi.mocked(markMessageRead).mockResolvedValue(null);
    render(<MobileMessagesPage />);
    await screen.findByText('预警提醒');
    const callsBefore = vi.mocked(getUnreadMessageCount).mock.calls.length;
    await userEvent.click(screen.getByTestId('msg-item-2'));
    await waitFor(() => expect(vi.mocked(getUnreadMessageCount).mock.calls.length).toBeGreaterThan(callsBefore));
    expect(await screen.findByText(/0 条未读/)).toBeTruthy();
  });

  it('markMessageRead 失败静默：条目仍展开、不消失', async () => {
    vi.mocked(listMyMessages).mockResolvedValue(msgs as never);
    vi.mocked(getUnreadMessageCount).mockResolvedValue(0);
    vi.mocked(markMessageRead).mockRejectedValue(new Error('x'));
    render(<MobileMessagesPage />);
    await screen.findByText('预警提醒');
    await userEvent.click(screen.getByTestId('msg-item-2'));
    expect(await screen.findByText(/孩子连续 3 次发起闲聊/)).toBeTruthy();
    expect(screen.getByTestId('msg-item-2')).toBeTruthy();
  });

  it('空态与错误重试', async () => {
    vi.mocked(listMyMessages).mockResolvedValue([] as never);
    vi.mocked(getUnreadMessageCount).mockResolvedValue(0);
    const { unmount } = render(<MobileMessagesPage />);
    expect(await screen.findByText(/暂无消息/)).toBeTruthy();
    unmount();
    vi.mocked(listMyMessages).mockRejectedValue(new Error('x'));
    render(<MobileMessagesPage />);
    expect(await screen.findByTestId('messages-retry')).toBeTruthy();
  });
});
