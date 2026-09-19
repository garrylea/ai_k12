import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { routes } from '@/routes/routeTable';
import {
  ApiError,
  getParentGoalAttainment,
  putParentGoalTarget,
  listMyStudents,
  getUnreadMessageCount,
  type MyStudentItem,
  type ParentGoalAttainment,
  type ParentGoalAttainmentItem,
} from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';
import { useThemeStore } from '@/store/themeStore';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    listMyStudents: vi.fn(),
    getUnreadMessageCount: vi.fn(),
    getParentGoalAttainment: vi.fn(),
    putParentGoalTarget: vi.fn(),
  };
});

const listMyStudentsMock = vi.mocked(listMyStudents);
const getUnreadMock = vi.mocked(getUnreadMessageCount);
const getGoalsMock = vi.mocked(getParentGoalAttainment);
const putGoalMock = vi.mocked(putParentGoalTarget);

const BOY: MyStudentItem = { id: 11, parentId: 3, username: 'xiaoming', name: '小明', age: 13, grade: '初一', schoolLevel: 'junior', isActive: true };
const GIRL: MyStudentItem = { id: 12, parentId: 3, username: 'xiaohong', name: '小红', age: 10, grade: '四年级', schoolLevel: 'primary', isActive: true };

const goal = (
  metric: ParentGoalAttainmentItem['metric'],
  title: string,
  period: ParentGoalAttainmentItem['period'],
  target: number,
  achieved: number,
  rate: number | null,
): ParentGoalAttainmentItem => ({ metric, period, title, target, achieved, rate });

const ATTAINMENT: ParentGoalAttainment = {
  items: [
    goal('daily_study_minutes', '每日学习时长', 'daily', 60, 30, 50),
    goal('daily_words', '每日背单词', 'daily', 20, 10, 50),
    goal('weekly_passages', '每周古诗文篇目', 'weekly', 8, 2, 25),
    goal('weekly_clear_errors', '每周清零错题', 'weekly', 10, 1, 10),
  ],
};

function validToken(): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `header.${payload}.signature`;
}

function renderAt(path: string) {
  localStorage.setItem('token', validToken());
  localStorage.setItem('userRole', 'parent');
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const result = render(<RouterProvider router={router} />);
  return { router, ...result };
}

/** 行定位：拿 testid 那一行，避免断言串到别的目标上。 */
const row = async (metric: string) => within(await screen.findByTestId(`goal-row-${metric}`));

beforeEach(() => {
  localStorage.clear();
  useParentStudentStore.setState({ studentId: 11 });
  listMyStudentsMock.mockReset();
  listMyStudentsMock.mockResolvedValue([BOY]);
  getUnreadMock.mockReset();
  getUnreadMock.mockResolvedValue(0);
  getGoalsMock.mockReset();
  getGoalsMock.mockResolvedValue(ATTAINMENT);
  putGoalMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useParentStudentStore.setState({ studentId: null });
  useThemeStore.setState({ mode: 'student-day' });
});

describe('ParentGoalsPage', () => {
  it('渲染四个维度目标（标题用后端给的 title，不自己编）', async () => {
    renderAt('/parent/goals');

    expect(await screen.findByTestId('goals-card')).toBeTruthy();
    for (const g of ATTAINMENT.items) {
      expect(await screen.findByTestId(`goal-row-${g.metric}`)).toBeTruthy();
    }
    expect((await row('daily_study_minutes')).getByText('每日学习时长')).toBeTruthy();
    expect((await row('weekly_passages')).getByText('每周古诗文篇目')).toBeTruthy();
    expect(getGoalsMock).toHaveBeenCalledWith(11);
  });

  it('rate=null → 显示「暂无数据」，绝不显示 0%', async () => {
    getGoalsMock.mockResolvedValue({
      items: [goal('daily_words', '每日背单词', 'daily', 0, 0, null)],
    });
    renderAt('/parent/goals');

    const r = await row('daily_words');
    expect(r.getByText('暂无数据')).toBeTruthy();
    expect(r.queryByText('0%')).toBeNull();
  });

  it('rate>100 → 明确标「已超额」，不截断成 100%', async () => {
    getGoalsMock.mockResolvedValue({
      items: [goal('daily_words', '每日背单词', 'daily', 10, 15, 150)],
    });
    renderAt('/parent/goals');

    const r = await row('daily_words');
    expect(r.getByText(/已超额/)).toBeTruthy();
    expect(r.getByText(/150%/)).toBeTruthy();
  });

  it('改值保存 → 调 PUT，并用**响应**原地更新该行（不再发 GET）', async () => {
    putGoalMock.mockResolvedValue(
      goal('daily_words', '每日背单词', 'daily', 30, 12, 40),
    );
    renderAt('/parent/goals');
    const r = await row('daily_words');

    fireEvent.change(r.getByLabelText('每日背单词目标值'), { target: { value: '30' } });
    fireEvent.click(r.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(putGoalMock).toHaveBeenCalledWith(11, 'daily_words', 30));
    // 行元素在重渲染中不换节点，用同一个 scope 继续断言即可
    const after = await row('daily_words');
    await waitFor(() => expect(after.getByText(/已达成 12 \/ 30/)).toBeTruthy());
    // 达成率按响应重算，且没有为此再拉一次列表
    expect(after.getByText('40%')).toBeTruthy();
    expect(getGoalsMock).toHaveBeenCalledTimes(1);
  });

  it('保存失败 → 行内报错、**保留用户输入**、按钮恢复可点', async () => {
    putGoalMock.mockRejectedValue(new ApiError(1001, '入参校验失败：target 超出范围'));
    renderAt('/parent/goals');
    const r = await row('daily_words');

    fireEvent.change(r.getByLabelText('每日背单词目标值'), { target: { value: '30' } });
    fireEvent.click(r.getByRole('button', { name: '保存' }));

    expect(await screen.findByTestId('goal-error-daily_words')).toHaveTextContent('入参校验失败');
    // 输入框仍是家长刚打的值，不被回滚
    expect((await row('daily_words')).getByLabelText('每日背单词目标值')).toHaveValue(30);
    expect((await row('daily_words')).getByRole('button', { name: '保存' })).not.toBeDisabled();
  });

  it('非法目标值 → 前端先挡，不发请求', async () => {
    renderAt('/parent/goals');
    const r = await row('daily_words');

    fireEvent.change(r.getByLabelText('每日背单词目标值'), { target: { value: '0' } });
    fireEvent.click(r.getByRole('button', { name: '保存' }));

    expect(await screen.findByTestId('goal-error-daily_words')).toHaveTextContent('1–9999');
    expect(putGoalMock).not.toHaveBeenCalled();

    fireEvent.change(await (await row('daily_words')).getByLabelText('每日背单词目标值'), {
      target: { value: '10000' },
    });
    fireEvent.click((await row('daily_words')).getByRole('button', { name: '保存' }));
    expect(putGoalMock).not.toHaveBeenCalled();
  });

  it('没有任何孩子 → 未选择孩子卡，不取数', async () => {
    // ⚠️ 锚点不能只靠 setState(null) 造：`StudentSwitcher` 会在列表到位后把 null
    //    回落成第一个孩子（见其「校验 + 回落」effect），所以「没选孩子」的真实前提是
    //    **这个家长名下没有孩子**（列表为空 → 它才把锚点清成 null）。
    listMyStudentsMock.mockResolvedValue([]);
    useParentStudentStore.setState({ studentId: null });
    renderAt('/parent/goals');

    expect(await screen.findByTestId('goals-no-student')).toBeTruthy();
    expect(getGoalsMock).not.toHaveBeenCalled();
  });

  it('无权查看该孩子 → 403 卡，不渲染目标', async () => {
    getGoalsMock.mockRejectedValue(new ApiError(1005, '无权操作该学生'));
    renderAt('/parent/goals');

    expect(await screen.findByTestId('goals-student-forbidden')).toBeTruthy();
    expect(screen.queryByTestId('goals-card')).toBeNull();
  });

  it('切孩子时请求未回来 → 出骨架，不残留上一个孩子的数字（防「闪现旧数据」）', async () => {
    // 两个都在名下，否则 StudentSwitcher 会把锚点回落回 11，测不到「切孩子」这一帧
    listMyStudentsMock.mockResolvedValue([BOY, GIRL]);
    renderAt('/parent/goals');
    expect(await screen.findByText(/已达成 10 \/ 20/)).toBeTruthy();

    // 12 的请求挂着不 resolve
    getGoalsMock.mockImplementation(() => new Promise<ParentGoalAttainment>(() => {}));
    await act(async () => {
      useParentStudentStore.setState({ studentId: 12 });
    });

    expect(screen.queryByText(/已达成 10 \/ 20/)).toBeNull();
    expect(screen.getByTestId('goals-skeleton')).toBeTruthy();
  });
});
