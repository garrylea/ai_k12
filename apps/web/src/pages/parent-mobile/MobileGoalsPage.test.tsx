import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MobileGoalsPage from './MobileGoalsPage';
import { useParentStudentStore } from '@/store/parentStudentStore';

afterEach(() => { cleanup(); useParentStudentStore.setState({ studentId: 1 }); });

// store 初始 studentId 是 null（persist 空 localStorage 不恢复），首测渲染前必须先选中孩子
// —— 与 MobileDashboardPage.test.tsx 的 beforeEach 先例一致。
beforeEach(() => { useParentStudentStore.setState({ studentId: 1 }); });

vi.mock('@/services/api', () => ({
  getParentGoalAttainment: vi.fn(),
  putParentGoalTarget: vi.fn(),
}));
import { getParentGoalAttainment, putParentGoalTarget } from '@/services/api';

const items = {
  items: [
    { metric: 'daily_study_minutes' as const, subjectId: 2, subjectName: '数学', period: 'daily' as const, title: '每日学习分钟数', target: 30, achieved: 45, rate: 150 },
    { metric: 'weekly_clear_errors' as const, subjectId: 2, subjectName: '数学', period: 'weekly' as const, title: '每周清错题数', target: 5, achieved: 0, rate: null },
  ],
};

describe('MobileGoalsPage', () => {
  it('渲染达成度：rate>100 不截断，rate=null 显示 暂无数据', async () => {
    vi.mocked(getParentGoalAttainment).mockResolvedValue(items as never);
    render(<MobileGoalsPage />);
    expect(await screen.findByText(/150%/)).toBeTruthy();
    expect(screen.getByText(/暂无数据/)).toBeTruthy();
    // 渲染 key 用 subjectId:metric（两行都在）
    expect(screen.getByText(/每日学习分钟数/)).toBeTruthy();
    expect(screen.getByText(/每周清错题数/)).toBeTruthy();
  });

  it('编辑目标：正整数校验 + 保存就地更新返回项', async () => {
    vi.mocked(getParentGoalAttainment).mockResolvedValue(items as never);
    vi.mocked(putParentGoalTarget).mockResolvedValue({ ...items.items[0], target: 60, rate: 75 });
    render(<MobileGoalsPage />);
    await screen.findByText(/150%/);
    await userEvent.click(screen.getByTestId('goal-edit-2:daily_study_minutes'));
    const input = screen.getByTestId('goal-input-2:daily_study_minutes');
    await userEvent.type(input, '0');
    await userEvent.click(screen.getByTestId('goal-save-2:daily_study_minutes'));
    expect(putParentGoalTarget).not.toHaveBeenCalled();
    await userEvent.clear(input);
    await userEvent.type(input, '60');
    await userEvent.click(screen.getByTestId('goal-save-2:daily_study_minutes'));
    await waitFor(() => expect(putParentGoalTarget).toHaveBeenCalledWith(1, 'daily_study_minutes', 60, 2));
    expect(await screen.findByText(/75%/)).toBeTruthy();
  });

  it('拉取失败显示错误重试', async () => {
    vi.mocked(getParentGoalAttainment).mockRejectedValue(new Error('x'));
    render(<MobileGoalsPage />);
    expect(await screen.findByTestId('goals-retry')).toBeTruthy();
  });
});
