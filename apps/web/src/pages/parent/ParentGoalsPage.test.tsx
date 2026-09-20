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
  type ParentGoalMetric,
} from '@/services/api';
import { toast } from '@/components/base';
import { useParentStudentStore } from '@/store/parentStudentStore';
import { useThemeStore } from '@/store/themeStore';

vi.mock('@/components/base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/base')>();
  // 只替换 toast：其它基座原语（Input/Card/Button）必须是真的——本文件有一条用例要断言
  // 输入框用的是基座 Input 的类名。
  return { ...actual, toast: vi.fn() };
});

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
const toastMock = vi.mocked(toast);

const BOY: MyStudentItem = { id: 11, parentId: 3, username: 'xiaoming', name: '小明', age: 13, grade: '初一', schoolLevel: 'junior', isActive: true };
const GIRL: MyStudentItem = { id: 12, parentId: 3, username: 'xiaohong', name: '小红', age: 10, grade: '四年级', schoolLevel: 'primary', isActive: true };

const MATH = { subjectId: 1, subjectName: '数学' };
const CHINESE = { subjectId: 2, subjectName: '语文' };
const ENGLISH = { subjectId: 3, subjectName: '英语' };

const goal = (
  subject: { subjectId: number; subjectName: string },
  metric: ParentGoalMetric,
  title: string,
  period: ParentGoalAttainmentItem['period'],
  target: number,
  achieved: number,
  rate: number | null,
): ParentGoalAttainmentItem => ({ ...subject, metric, title, period, target, achieved, rate });

/** 后端顺序即渲染顺序：数学 → 语文 → 英语（学科内按指标模板顺序）。 */
const ATTAINMENT: ParentGoalAttainment = {
  items: [
    goal(MATH, 'daily_study_minutes', '每日学习时长', 'daily', 30, 15, 50),
    goal(MATH, 'weekly_lessons', '每周完课', 'weekly', 2, 1, 50),
    goal(CHINESE, 'daily_study_minutes', '每日学习时长', 'daily', 30, 6, 20),
    goal(CHINESE, 'weekly_lessons', '每周完课', 'weekly', 2, 2, 100), // 语文也有通用指标
    goal(CHINESE, 'weekly_passages', '每周古诗文篇目', 'weekly', 8, 2, 25),
    goal(ENGLISH, 'daily_words', '每日背单词', 'daily', 20, 10, 50),
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

/** 行元素（要断言 textContent / 类名时必须拿元素，`within()` 的返回值只是查询方法集）。 */
const rowEl = async (key: string) => await screen.findByTestId(`goal-row-${key}`);
/** 行内查询（定位行内的输入框/按钮/文案）。 */
const row = async (key: string) => within(await rowEl(key));

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
  toastMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useParentStudentStore.setState({ studentId: null });
  useThemeStore.setState({ mode: 'student-day' });
});

describe('ParentGoalsPage 按学科分组', () => {
  it('按学科分组渲染：语文组里有「每周古诗文篇目」，英语组里有「每日背单词」', async () => {
    renderAt('/parent/goals');

    expect(await screen.findByTestId('goals-subject-1')).toHaveTextContent('数学');
    expect(await screen.findByTestId('goals-subject-2')).toHaveTextContent('语文');
    expect(await screen.findByTestId('goals-subject-3')).toHaveTextContent('英语');

    const chinese = await screen.findByTestId('goals-subject-2');
    expect(chinese).toHaveTextContent('每周古诗文篇目');
    expect(chinese).toHaveTextContent('每周完课');
    expect(chinese).not.toHaveTextContent('每日背单词');

    const english = await screen.findByTestId('goals-subject-3');
    expect(english).toHaveTextContent('每日背单词');
    expect(english).not.toHaveTextContent('每周古诗文篇目');

    expect(getGoalsMock).toHaveBeenCalledWith(11);
  });

  it('行内带单位（分钟/课/篇/词），不把目标写成没单位的数字', async () => {
    renderAt('/parent/goals');

    expect(await rowEl('1:weekly_lessons')).toHaveTextContent('已达成 1 / 2 课');
    expect(await rowEl('2:weekly_passages')).toHaveTextContent('已达成 2 / 8 篇');
    expect(await rowEl('3:daily_words')).toHaveTextContent('已达成 10 / 20 词');
    expect(await rowEl('1:daily_study_minutes')).toHaveTextContent('已达成 15 / 30 分钟');
  });
});

describe('ParentGoalsPage 同指标跨学科不串', () => {
  it('改数学那行 → 只传数学的 subjectId，且只有该行数字变化', async () => {
    putGoalMock.mockResolvedValue(
      goal(MATH, 'daily_study_minutes', '每日学习时长', 'daily', 45, 15, 33.3),
    );
    renderAt('/parent/goals');

    const mathRow = await row('1:daily_study_minutes');
    fireEvent.change(mathRow.getByLabelText('每日学习时长（数学）目标值'), {
      target: { value: '45' },
    });
    fireEvent.click(mathRow.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(putGoalMock).toHaveBeenCalledWith(11, 'daily_study_minutes', 45, 1),
    );
    const after = await row('1:daily_study_minutes');
    await waitFor(() => expect(after.getByText(/已达成 15 \/ 45/)).toBeTruthy());
    // 语文那行（同 metric）仍是它自己的 30，没被串改
    expect((await row('2:daily_study_minutes')).getByText(/已达成 6 \/ 30/)).toBeTruthy();
    expect(getGoalsMock).toHaveBeenCalledTimes(1);
  });

  it('保存失败时只有该行报错（key 是 学科:指标，不会串到同 metric 的其它学科）', async () => {
    putGoalMock.mockRejectedValue(new ApiError(1001, 'daily_words 不适用于该学科'));
    renderAt('/parent/goals');

    const englishRow = await row('3:daily_words');
    fireEvent.change(englishRow.getByLabelText('每日背单词（英语）目标值'), {
      target: { value: '30' },
    });
    fireEvent.click(englishRow.getByRole('button', { name: '保存' }));

    expect(await screen.findByTestId('goal-error-3:daily_words')).toHaveTextContent(
      '不适用于该学科',
    );
    expect(screen.getAllByTestId(/^goal-error-/)).toHaveLength(1);
  });
});

describe('ParentGoalsPage 达成率口径', () => {
  it('rate=null → 该行显示「暂无数据」，绝不显示 0%', async () => {
    getGoalsMock.mockResolvedValue({
      items: [goal(MATH, 'weekly_lessons', '每周完课', 'weekly', 0, 0, null)],
    });
    renderAt('/parent/goals');

    const el = await rowEl('1:weekly_lessons');
    expect(el).toHaveTextContent('暂无数据');
    expect(el.textContent).not.toContain('0%');
  });

  it('rate>100 → 标「已超额」，不截断成 100%', async () => {
    getGoalsMock.mockResolvedValue({
      items: [goal(ENGLISH, 'daily_words', '每日背单词', 'daily', 10, 15, 150)],
    });
    renderAt('/parent/goals');

    const r = await row('3:daily_words');
    expect(r.getByText(/已超额/)).toBeTruthy();
    expect(r.getByText(/150%/)).toBeTruthy();
  });
});

describe('ParentGoalsPage 保存交互', () => {
  it('非法目标值 → 前端先挡，不发请求', async () => {
    renderAt('/parent/goals');
    const r = await row('1:weekly_lessons');

    fireEvent.change(r.getByLabelText('每周完课（数学）目标值'), { target: { value: '0' } });
    fireEvent.click(r.getByRole('button', { name: '保存' }));

    expect(await screen.findByTestId('goal-error-1:weekly_lessons')).toHaveTextContent('1–9999');
    expect(putGoalMock).not.toHaveBeenCalled();
  });

  it('保存失败 → 行内报错、**保留用户输入**、按钮恢复可点', async () => {
    putGoalMock.mockRejectedValue(new ApiError(1001, '入参校验失败'));
    renderAt('/parent/goals');
    const r = await row('1:weekly_lessons');

    fireEvent.change(r.getByLabelText('每周完课（数学）目标值'), { target: { value: '5' } });
    fireEvent.click(r.getByRole('button', { name: '保存' }));

    expect(await screen.findByTestId('goal-error-1:weekly_lessons')).toHaveTextContent(
      '入参校验失败',
    );
    const after = await row('1:weekly_lessons');
    expect(after.getByLabelText('每周完课（数学）目标值')).toHaveValue(5);
    expect(after.getByRole('button', { name: '保存' })).not.toBeDisabled();
  });

  it('保存成功 → 弹「已保存」并**回显服务端保存后的值**（值没变时也要有反馈，2026-09-20 走查踩坑）', async () => {
    putGoalMock.mockResolvedValue(
      goal(ENGLISH, 'daily_words', '每日背单词', 'daily', 25, 10, 40),
    );
    renderAt('/parent/goals');

    const r = await row('3:daily_words');
    fireEvent.change(r.getByLabelText('每日背单词（英语）目标值'), { target: { value: '25' } });
    fireEvent.click(r.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('success', '已保存：每日背单词 25 词'));
  });

  it('保存失败 → 除了行内报错，还给一条全局 error 提示（行内小字在窄屏下容易被忽略）', async () => {
    putGoalMock.mockRejectedValue(new ApiError(1001, 'daily_words 不适用于该学科'));
    renderAt('/parent/goals');

    const r = await row('3:daily_words');
    fireEvent.click(r.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith('error', '保存失败：daily_words 不适用于该学科'),
    );
    expect(await screen.findByTestId('goal-error-3:daily_words')).toBeInTheDocument();
  });

  it('数字输入用基座 Input（border-2 + 聚焦变蓝）—— 1B 走查时它像静态文字，这条钉住修复', async () => {
    renderAt('/parent/goals');

    const input = (await row('3:daily_words')).getByLabelText('每日背单词（英语）目标值');
    const wrapper = input.closest('div');
    expect(wrapper?.className).toContain('border-2');
    expect(wrapper?.className).toContain('focus-within:border-[var(--brand-500)]');
  });
});

describe('ParentGoalsPage 边界态', () => {
  it('没有在学学科（items 为空）→ 「先去配置教材」引导（后端不编造默认目标）', async () => {
    getGoalsMock.mockResolvedValue({ items: [] });
    renderAt('/parent/goals');

    const empty = await screen.findByTestId('goals-empty');
    expect(empty).toHaveTextContent('还没有在学学科');
    expect(within(empty).getByRole('link', { name: '去配置教材' })).toHaveAttribute(
      'href',
      '/parent/students/11/config',
    );
  });

  it('没有任何孩子 → 未选择孩子卡，不取数', async () => {
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
    expect(screen.queryByTestId('goals-subject-1')).toBeNull();
  });

  it('切孩子时请求未回来 → 出骨架，不残留上一个孩子的数字（防「闪现旧数据」）', async () => {
    listMyStudentsMock.mockResolvedValue([BOY, GIRL]);
    renderAt('/parent/goals');
    expect(await screen.findByText(/已达成 10 \/ 20 词/)).toBeTruthy();

    getGoalsMock.mockImplementation(() => new Promise<ParentGoalAttainment>(() => {}));
    await act(async () => {
      useParentStudentStore.setState({ studentId: 12 });
    });

    expect(screen.queryByText(/已达成 10 \/ 20 词/)).toBeNull();
    expect(screen.getByTestId('goals-skeleton')).toBeTruthy();
  });
});
