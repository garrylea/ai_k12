import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MobileControlsPage from './MobileControlsPage';
import { useParentStudentStore } from '@/store/parentStudentStore';
import type { ParentSessionPage } from '@/services/api';

// 进出时间的真实数据源是 getParentLearningSessions（桌面 ParentDashboardPage
// LearningTimelineCard 同款 API 与口径），不是 brief 初稿猜的 getParentStudyTime
// （那是按天聚合，与「列表不是聚合」矛盾）。测试 mock 同步修正。
vi.mock('@/services/api', () => ({
  getParentControls: vi.fn(),
  putParentControls: vi.fn(),
  issueParentDeviceCommand: vi.fn(),
  getParentLearningSessions: vi.fn(),
}));
import {
  getParentControls,
  getParentLearningSessions,
  issueParentDeviceCommand,
  putParentControls,
} from '@/services/api';

afterEach(() => {
  cleanup();
  useParentStudentStore.setState({ studentId: 1 });
});
// brief 初稿只在 afterEach 设 studentId，第 1 个用例跑的时候还是 null（渲染「先选择孩子」
// 而非表单）。补 beforeEach 保证每个用例从 studentId=1 开始。
beforeEach(() => {
  useParentStudentStore.setState({ studentId: 1 });
  // 清掉上个用例留在 vi.fn() 上的调用历史（如 not.toHaveBeenCalled 断言依赖它）
  vi.clearAllMocks();
});

const controls = { alertAwayMinutes: 5, alertIdleMinutes: 15, sessionLockMinutes: 30 };

function ok() {
  vi.mocked(getParentControls).mockResolvedValue(controls);
  vi.mocked(getParentLearningSessions).mockResolvedValue({ items: [], total: 0 });
}

describe('MobileControlsPage', () => {
  it('渲染当前锁定分钟数与输入框', async () => {
    ok();
    render(<MobileControlsPage />);
    expect(await screen.findByDisplayValue('30')).toBeTruthy();
  });

  it('保存只发改动字段并回显服务端值', async () => {
    ok();
    vi.mocked(putParentControls).mockResolvedValue({ ...controls, sessionLockMinutes: 60 });
    render(<MobileControlsPage />);
    await screen.findByDisplayValue('30');
    const input = screen.getByLabelText(/单次锁定/);
    await userEvent.clear(input);
    await userEvent.type(input, '60');
    await userEvent.click(screen.getByTestId('save-lock'));
    await waitFor(() =>
      expect(putParentControls).toHaveBeenCalledWith(1, { sessionLockMinutes: 60 }),
    );
    expect(await screen.findByDisplayValue('60')).toBeTruthy();
  });

  it('清空保存 = 显式解除（sessionLockMinutes: null）', async () => {
    ok();
    vi.mocked(putParentControls).mockResolvedValue({ ...controls, sessionLockMinutes: null });
    render(<MobileControlsPage />);
    await screen.findByDisplayValue('30');
    await userEvent.clear(screen.getByLabelText(/单次锁定/));
    await userEvent.click(screen.getByTestId('save-lock'));
    await waitFor(() =>
      expect(putParentControls).toHaveBeenCalledWith(1, { sessionLockMinutes: null }),
    );
  });

  it('非法输入（越界/非整数）不发起保存，行内报错', async () => {
    ok();
    render(<MobileControlsPage />);
    await screen.findByDisplayValue('30');
    const input = screen.getByLabelText(/单次锁定/);
    await userEvent.clear(input);
    await userEvent.type(input, '500');
    await userEvent.click(screen.getByTestId('save-lock'));
    expect(putParentControls).not.toHaveBeenCalled();
    expect(await screen.findByText('锁定时长需为 1–480 的整数，清空表示解除')).toBeTruthy();
  });

  it('远程解除走 device-commands，无会话 409 文案原样展示', async () => {
    ok();
    vi.mocked(issueParentDeviceCommand).mockRejectedValue(new Error('当前没有进行中的学习会话'));
    render(<MobileControlsPage />);
    await screen.findByDisplayValue('30');
    await userEvent.click(screen.getByTestId('unlock-now'));
    expect(await screen.findByText(/当前没有进行中的学习会话/)).toBeTruthy();
  });

  it('成功下发显示确认提示', async () => {
    ok();
    vi.mocked(issueParentDeviceCommand).mockResolvedValue({
      id: 3, command: 'unlock', status: 'pending', learningSessionId: 77, createdAt: '2026-10-01T09:00:00Z',
    });
    render(<MobileControlsPage />);
    await screen.findByDisplayValue('30');
    await userEvent.click(screen.getByTestId('unlock-now'));
    expect(await screen.findByText(/解除命令已下发/)).toBeTruthy();
  });

  it('进出时间列表按次展示进入/退出时刻（不聚合）', async () => {
    ok();
    // 与桌面 ParentDashboardPage.test 的 SESSIONS 同构：一条进行中（在线）、一条已退出。
    // 不断言具体墙钟字符串（formatClock 依赖本机时区，脆断）；按次与状态词是硬语义。
    const page: ParentSessionPage = {
      items: [
        {
          id: 78, startedAt: '2026-10-01T02:00:00.000Z', endedAt: null, online: true,
          lockMinutes: 30, lockExpiresAt: null, unlockedAt: null,
        },
        {
          id: 77, startedAt: '2026-09-30T09:00:00.000Z', endedAt: '2026-09-30T09:40:00.000Z',
          online: false, lockMinutes: 30, lockExpiresAt: null, unlockedAt: null,
        },
      ],
      total: 2,
    };
    vi.mocked(getParentLearningSessions).mockResolvedValue(page);
    render(<MobileControlsPage />);
    expect(await screen.findByTestId('session-78')).toBeTruthy();
    expect(screen.getByTestId('session-78').textContent).toContain('进行中');
    expect(screen.getByTestId('session-77').textContent).toContain('已退出');
    // 两行（不聚合）：两条会话各渲染一行
    expect(screen.getAllByTestId(/^session-/)).toHaveLength(2);
  });
});
