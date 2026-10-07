import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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

  it('studentId 为 null 显示未选择孩子，且 testid 容器仍在', () => {
    useParentStudentStore.setState({ studentId: null });
    render(<MobileGoalsPage />);
    expect(screen.getByText(/先在上方选择孩子/)).toBeTruthy();
    expect(screen.getByTestId('mobile-page-goals')).toBeTruthy();
  });

  it('快速切孩子：旧孩子在途响应 resolve 后不得覆盖新孩子、不得卡骨架（竞态守卫）', async () => {
    // 孩子 1 的达成度挂在不主动 resolve 的 deferred 上，制造「已切走、旧响应在途」
    let resolveOld!: (value: typeof items) => void;
    const oldP = new Promise<typeof items>((resolve) => { resolveOld = resolve; });
    const child2 = {
      items: [
        { metric: 'daily_study_minutes' as const, subjectId: 3, subjectName: '英语', period: 'daily' as const, title: '孩子2专属目标', target: 20, achieved: 10, rate: 50 },
      ],
    };
    vi.mocked(getParentGoalAttainment).mockImplementation((id: number) =>
      id === 1 ? oldP : Promise.resolve(child2));
    render(<MobileGoalsPage />);
    // 孩子 1 的数据未到就切到孩子 2
    act(() => { useParentStudentStore.setState({ studentId: 2 }); });
    // 孩子 2 的数据正常到达（没被旧请求卡死）
    expect(await screen.findByText(/孩子2专属目标/)).toBeTruthy();
    // 旧孩子的响应这时才 resolve —— cancelled 守卫必须把它整个丢弃：
    // 否则孩子 1 数据写回 + ownerId(1)!==studentId(2) → 永久骨架屏
    await act(async () => { resolveOld(items); });
    expect(screen.getByText(/孩子2专属目标/)).toBeTruthy();
    // 孩子 1 的两行（150% 那行与「暂无数据」那行）都没混进来
    expect(screen.queryByText(/每日学习分钟数/)).toBeNull();
    expect(screen.queryByText(/150%/)).toBeNull();
    expect(screen.queryByText(/暂无数据/)).toBeNull();
  });

  it('切孩在途：旧孩子响应 reject 不得把新孩子打成 error', async () => {
    let rejectOld!: (e: Error) => void;
    const oldP = new Promise<typeof items>((_, reject) => { rejectOld = reject; });
    const child2 = {
      items: [
        { metric: 'daily_study_minutes' as const, subjectId: 3, subjectName: '英语', period: 'daily' as const, title: '孩子2专属目标', target: 20, achieved: 10, rate: 50 },
      ],
    };
    vi.mocked(getParentGoalAttainment).mockImplementation((id: number) =>
      id === 1 ? oldP : Promise.resolve(child2));
    render(<MobileGoalsPage />);
    act(() => { useParentStudentStore.setState({ studentId: 2 }); });
    expect(await screen.findByText(/孩子2专属目标/)).toBeTruthy();
    // 旧孩子的请求这时才 reject —— 不许把孩子 2 打成「加载失败」
    await act(async () => { rejectOld(new Error('late failure')); });
    expect(screen.getByText(/孩子2专属目标/)).toBeTruthy();
    expect(screen.queryByTestId('goals-retry')).toBeNull();
  });

  it('编辑态下换孩子：编辑态与草稿清空，不得带进新孩子同 key 的行', async () => {
    // 两个孩子都有 subjectId:2 + daily_study_minutes（同 key），无守卫时
    // 旧孩子的编辑态/草稿会原样出现在新孩子的行上，保存即写错目标。
    const child2 = {
      items: [
        { metric: 'daily_study_minutes' as const, subjectId: 2, subjectName: '数学', period: 'daily' as const, title: '每日学习分钟数', target: 25, achieved: 5, rate: 20 },
      ],
    };
    vi.mocked(getParentGoalAttainment).mockImplementation((id: number) =>
      Promise.resolve(id === 1 ? items : child2));
    render(<MobileGoalsPage />);
    await screen.findByText(/150%/);
    await userEvent.click(screen.getByTestId('goal-edit-2:daily_study_minutes'));
    const input = screen.getByTestId('goal-input-2:daily_study_minutes');
    await userEvent.type(input, '99');
    // 草稿未保存就切到孩子 2
    act(() => { useParentStudentStore.setState({ studentId: 2 }); });
    // 新孩子数据到达后：编辑态必须已清空（回普通态），草稿不残留
    expect(await screen.findByText(/达成 20%/)).toBeTruthy();
    expect(screen.queryByTestId('goal-input-2:daily_study_minutes')).toBeNull();
    expect(screen.getByTestId('goal-edit-2:daily_study_minutes')).toBeTruthy();
  });
});
