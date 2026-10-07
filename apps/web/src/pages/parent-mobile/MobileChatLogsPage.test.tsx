import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MobileChatLogsPage from './MobileChatLogsPage';
import { useParentStudentStore } from '@/store/parentStudentStore';

// store 初始 studentId 是 null：首个用例渲染前也要有孩子（MobilePointsPage.test.tsx 同款）
beforeEach(() => { useParentStudentStore.setState({ studentId: 1 }); });
afterEach(() => { cleanup(); useParentStudentStore.setState({ studentId: 1 }); });

vi.mock('@/services/api', () => ({
  getParentChatLogs: vi.fn(),
  getParentChatLogDetail: vi.fn(),
}));
import { getParentChatLogDetail, getParentChatLogs } from '@/services/api';

const logItem = { id: 11, track: 'mainline', scene: 'mainline', title: '一元二次方程讨论', subjectId: 2, createdAt: '2026-10-05T10:00:00Z', updatedAt: '2026-10-05T10:30:00Z', messageCount: 4, blockCount: 1 };
const page1 = { items: [logItem], page: 1, pageSize: 20, total: 1 };
const detail = { ...logItem, messages: [
  { id: 1, role: 'user', content: '老师，什么是判别式？', reasoning: null, type: null, model: null, safetyFlag: 0, createdAt: '2026-10-05T10:00:00Z', images: [] },
  { id: 2, role: 'assistant', content: '判别式是 $b^2-4ac$。', reasoning: null, type: null, model: 'qwen', safetyFlag: 1, createdAt: '2026-10-05T10:01:00Z', images: [] },
] };

describe('MobileChatLogsPage', () => {
  it('渲染会话列表：标题/句数/偏离标记/track 筛选', async () => {
    vi.mocked(getParentChatLogs).mockResolvedValue(page1 as never);
    render(<MobileChatLogsPage />);
    expect(await screen.findByText(/一元二次方程讨论/)).toBeTruthy();
    expect(screen.getByText(/4 句/)).toBeTruthy();
    expect(screen.getByText(/偏离学习/)).toBeTruthy();
    await userEvent.click(screen.getByTestId('chatlogs-track-mainline'));
    await waitFor(() => expect(getParentChatLogs).toHaveBeenLastCalledWith(expect.objectContaining({ track: 'mainline', page: 1 })));
  });

  it('点会话进整页回放：Markdown/公式渲染 + 偏离标记 + 返回列表', async () => {
    vi.mocked(getParentChatLogs).mockResolvedValue(page1 as never);
    vi.mocked(getParentChatLogDetail).mockResolvedValue(detail as never);
    render(<MobileChatLogsPage />);
    await screen.findByText(/一元二次方程讨论/);
    await userEvent.click(screen.getByTestId('chatlog-open-11'));
    expect(await screen.findByTestId('chatlogs-detail')).toBeTruthy();
    expect(document.querySelector('.katex')).not.toBeNull();
    expect(screen.getAllByText(/偏离学习/).length).toBeGreaterThan(0);
    expect(getParentChatLogDetail).toHaveBeenCalledWith(1, 11);
    await userEvent.click(screen.getByTestId('chatlogs-back'));
    expect(await screen.findByText(/一元二次方程讨论/)).toBeTruthy();
  });

  it('回放 1002 失败：内联失败条，不弹全页错误', async () => {
    vi.mocked(getParentChatLogs).mockResolvedValue(page1 as never);
    vi.mocked(getParentChatLogDetail).mockRejectedValue(new Error('该会话不属于该学生'));
    render(<MobileChatLogsPage />);
    await screen.findByText(/一元二次方程讨论/);
    await userEvent.click(screen.getByTestId('chatlog-open-11'));
    expect(await screen.findByTestId('chatlogs-detail-error')).toBeTruthy();
    // 列表仍在（返回可重试）
    expect(screen.getByTestId('chatlogs-back')).toBeTruthy();
  });

  it('换孩子回第 1 页并重拉', async () => {
    vi.mocked(getParentChatLogs).mockResolvedValue(page1 as never);
    render(<MobileChatLogsPage />);
    await screen.findByText(/一元二次方程讨论/);
    vi.mocked(getParentChatLogs).mockClear();
    useParentStudentStore.setState({ studentId: 2 });
    await waitFor(() => expect(getParentChatLogs).toHaveBeenLastCalledWith(expect.objectContaining({ studentId: 2, page: 1 })));
  });
});
