import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { routes } from '@/routes/routeTable';
import {
  getParentDashboard,
  getParentSpecials,
  getParentStudyTime,
  getParentTodayUsage,
  getUnreadMessageCount,
  listMyStudents,
  type MyStudentItem,
  type ParentDashboard,
  type ParentSpecials,
  type ParentStudyTime,
  type ParentTodayUsage,
} from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';
import { useThemeStore } from '@/store/themeStore';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    listMyStudents: vi.fn(),
    getUnreadMessageCount: vi.fn(),
    getParentDashboard: vi.fn(),
    getParentStudyTime: vi.fn(),
    getParentTodayUsage: vi.fn(),
    // 专项学情卡（埋点 Phase 1B）自己取数；不 mock 会打到真 fetch（jsdom 里静默降级）
    getParentSpecials: vi.fn(),
  };
});

const listMyStudentsMock = vi.mocked(listMyStudents);
const getUnreadMock = vi.mocked(getUnreadMessageCount);
const getDashboardMock = vi.mocked(getParentDashboard);
const getStudyTimeMock = vi.mocked(getParentStudyTime);
const getTodayUsageMock = vi.mocked(getParentTodayUsage);
const getSpecialsMock = vi.mocked(getParentSpecials);

const BOY: MyStudentItem = { id: 11, parentId: 3, username: 'xiaoming', name: '小明', age: 13, grade: '初一', schoolLevel: 'junior', isActive: true };
const GIRL: MyStudentItem = { ...BOY, id: 12, username: 'xiaomei', name: '小美' };

/** 专项学情卡的默认数据（埋点 Phase 1B）。四个模块后端保证都在。 */
const SPECIALS: ParentSpecials = {
  dictation: { units: 3, correct: 2, rate: 66.7, byDay: [] },
  interpretation: { units: 5, correct: 4, rate: 80, byDay: [] },
  meaning: { units: 0, correct: 0, rate: null, byDay: [] },
  vocabulary: { units: 10, correct: 8, rate: 80, byDay: [], newWords: 7 },
};

const DASHBOARD: ParentDashboard = {
  unreadAlerts: 0,
  students: [
    {
      studentId: 11, name: '小明', grade: '初一', schoolLevel: 'junior',
      lastActiveAt: '2026-09-18T20:11:00.000Z', activeDays7: 3, unreadAlerts: 0,
      subjects: [
        {
          subjectId: 1, subjectName: '数学',
          progress: {
            completedUnits: 2, totalUnits: 8,
            currentUnitName: '第二章 整式的加减', currentLessonName: '2.1 整式', percent: 25,
          },
          accuracy: { answered: 42, correct: 31, rate: 73.8 },
          selfAssessed: { count: 5, correctCount: 3 },
          errorBook: { uncleared: 12, total: 20 },
          examCount: 4,
        },
      ],
    },
    {
      studentId: 12, name: '小美', grade: '初一', schoolLevel: 'junior',
      lastActiveAt: null, activeDays7: 0, unreadAlerts: 0,
      subjects: [
        {
          subjectId: 1, subjectName: '数学',
          progress: { completedUnits: 0, totalUnits: 8, currentUnitName: null, currentLessonName: null, percent: 0 },
          // 没做过题：rate 必须是 null，UI 应显示「暂无数据」而不是 0%
          accuracy: { answered: 0, correct: 0, rate: null },
          selfAssessed: { count: 0, correctCount: 0 },
          errorBook: { uncleared: 0, total: 0 },
          examCount: 0,
        },
      ],
    },
  ],
};

function studyTime(totalSeconds: number): ParentStudyTime {
  return {
    totalSeconds,
    activeDays: 2,
    byDay: [{ date: '2026-09-19', seconds: totalSeconds }],
    byModule: [{ module: 'en_vocabulary', seconds: totalSeconds }],
    bySubject: [],
    source: 'sessions',
  };
}

function validToken(): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `header.${payload}.signature`;
}

/**
 * 排空微任务队列：让挂在同一条 promise 链上的 then/catch 全部跑完。
 * `act` 同时保证由此触发的 React 更新已提交，便于随后做同步 DOM 断言。
 */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderAt(path: string) {
  localStorage.setItem('token', validToken());
  localStorage.setItem('userRole', 'parent');
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const result = render(<RouterProvider router={router} />);
  return { router, ...result };
}

beforeEach(() => {
  localStorage.clear();
  useParentStudentStore.setState({ studentId: null });
  listMyStudentsMock.mockReset();
  listMyStudentsMock.mockResolvedValue([BOY, GIRL]);
  getUnreadMock.mockReset();
  getUnreadMock.mockResolvedValue(0);
  getDashboardMock.mockReset();
  getDashboardMock.mockResolvedValue(DASHBOARD);
  getStudyTimeMock.mockReset();
  getStudyTimeMock.mockResolvedValue(studyTime(5400));
  getTodayUsageMock.mockReset();
  // 1860s → 「31 分钟」。用这个**非整点**的数字是为了让断言只可能来自时长值本身
  // （整点数字容易与其它文案撞车，断言会变成「等于没写」）。
  getTodayUsageMock.mockResolvedValue({
    date: '2026-09-19',
    activeSeconds: 1860,
    byModule: [{ module: 'en_vocabulary', seconds: 1860 }],
  });
  getSpecialsMock.mockReset();
  getSpecialsMock.mockResolvedValue(SPECIALS);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useParentStudentStore.setState({ studentId: null });
  useThemeStore.setState({ mode: 'student-day' });
});

describe('ParentDashboardPage', () => {
  it('渲染首个孩子的学科卡片（进度 / 正确率 / 错题 / 考试 / 活跃天数）', async () => {
    renderAt('/parent/dashboard');

    const panel = await screen.findByTestId('dashboard-student-11');
    expect(panel).toHaveTextContent('数学');
    expect(panel).toHaveTextContent('2 / 8');
    expect(panel).toHaveTextContent('第二章 整式的加减');
    expect(panel).toHaveTextContent('2.1 整式');
    expect(panel).toHaveTextContent('73.8%');
    expect(panel).toHaveTextContent('12');
    expect(panel).toHaveTextContent('4');
    expect(panel).toHaveTextContent('3');
  });

  it('rate 为 null → 显示「暂无数据」，不显示 0%', async () => {
    renderAt('/parent/dashboard');
    await screen.findByTestId('dashboard-student-11');

    fireEvent.click(screen.getByRole('tab', { name: '小美' }));

    const panel = await screen.findByTestId('dashboard-student-12');
    /**
     * 断言必须**限定在学科卡内**，不能对整个面板做 `not.toHaveTextContent('0%')`：
     * 面板里还有别的含百分比的卡（专项学情的 80% 就含子串「0%」），
     * 整面板断言会把「别的卡显示 80%」误判成「正确率显示成了 0%」。
     */
    const subjectCard = within(panel).getByTestId('dashboard-subject-1');
    expect(subjectCard).toHaveTextContent('暂无数据');
    expect(subjectCard).not.toHaveTextContent('0%');
  });

  it('多孩 → 出孩子 Tab；点 Tab 只在本地切换，**不动锚点**', async () => {
    renderAt('/parent/dashboard');
    await screen.findByTestId('dashboard-student-11');

    fireEvent.click(screen.getByRole('tab', { name: '小美' }));

    await screen.findByTestId('dashboard-student-12');
    // 顶栏 StudentSwitcher 挂载时会把锚点落到第一个孩子（11）；
    // 点 Tab 只切本地展示，**不能**把它改成 12 —— 否则一次点击就改了「当前查看的孩子」，
    // 报告/错题/回放三页会跟着跳走。
    expect(useParentStudentStore.getState().studentId).toBe(11);
  });

  it('单孩 → 不出孩子 Tab（省掉一个从不变化的控件）', async () => {
    listMyStudentsMock.mockResolvedValue([BOY]);
    getDashboardMock.mockResolvedValue({ ...DASHBOARD, students: [DASHBOARD.students[0]] });

    renderAt('/parent/dashboard');

    expect(await screen.findByTestId('dashboard-student-11')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('快捷入口先设锚点再导航（否则报告页会跟错孩子）', async () => {
    const { router } = renderAt('/parent/dashboard');
    await screen.findByTestId('dashboard-student-11');

    fireEvent.click(screen.getByRole('tab', { name: '小美' }));
    const panel = await screen.findByTestId('dashboard-student-12');
    fireEvent.click(within(panel).getByRole('button', { name: '学情报告' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/parent/report'));
    expect(useParentStudentStore.getState().studentId).toBe(12);
    // 仪表盘的核心特性是「一次请求拿全所有孩子」——切 Tab 只换本地展示，不许重拉。
    // 这条断言是唯一能钉住「不按孩子逐个请求 / 不因切 Tab 重拉」的东西。
    expect(getDashboardMock).toHaveBeenCalledTimes(1);
  });

  it('名下没有孩子 → 空态 + 去创建账号的入口', async () => {
    listMyStudentsMock.mockResolvedValue([]);
    getDashboardMock.mockResolvedValue({ students: [], unreadAlerts: 0 });

    renderAt('/parent/dashboard');

    const empty = await screen.findByTestId('dashboard-empty');
    // 必须**限定在空态容器内**查：没有孩子时顶栏 `StudentSwitcher` 也会渲染一个
    // 「去创建学生账号」链接，不加限定的 getByRole 会同时命中两个而抛错。
    expect(within(empty).getByRole('link', { name: /创建学生账号/ })).toBeInTheDocument();
  });

  it('加载中 → 骨架，不到货不渲染卡片', async () => {
    getDashboardMock.mockImplementation(() => new Promise(() => {}));

    renderAt('/parent/dashboard');

    expect(await screen.findByTestId('dashboard-skeleton')).toBeInTheDocument();
  });

  it('接口报错 → 错误条 + 重试可重新拉取', async () => {
    getDashboardMock.mockRejectedValueOnce(new Error('boom'));

    renderAt('/parent/dashboard');

    const errBox = await screen.findByTestId('dashboard-error');
    getDashboardMock.mockResolvedValue(DASHBOARD);
    fireEvent.click(within(errBox).getByRole('button', { name: '重试' }));

    expect(await screen.findByTestId('dashboard-student-11')).toBeInTheDocument();
  });

  it('学习时长与活跃天数**并列**展示，文案区分口径（不许替换）', async () => {
    renderAt('/parent/dashboard');
    await waitFor(() => expect(screen.getByTestId('dashboard-study-time-11')).toBeTruthy());

    // 新卡：会话口径
    expect(screen.getByTestId('dashboard-study-time-11').textContent).toContain('1 小时 30 分');
    expect(screen.getByTestId('dashboard-study-time-11').textContent).toContain('会话口径');
    // 旧口径仍在，未被替换。用带数值的整串匹配：新卡文案里也含「近 7 天活跃天数」，
    // 只匹配 /近 7 天活跃/ 会同时命中两处；带上「3 天」才能唯一锚定旧口径那行。
    expect(screen.getByText(/近 7 天活跃 3 天/)).toBeTruthy();
  });

  it('今日已用：只展示时长，**不再有「每日上限」**（该概念 2026-09-23 已废除）', async () => {
    renderAt('/parent/dashboard');
    await waitFor(() => expect(screen.getByTestId('dashboard-today-usage-11')).toBeTruthy());

    const text = screen.getByTestId('dashboard-today-usage-11').textContent ?? '';
    // activeSeconds=1860 → 「31 分钟」
    expect(text).toContain('31 分钟');
    // 回归钉子：后端 today-usage 已删 limitMinutes/exceeded，前端若照旧稿渲染上限文案，
    // 运行时字段是 undefined，会画出「每日上限 undefined 分钟」。
    expect(text).not.toContain('每日上限');
    expect(text).not.toContain('undefined');
  });

  it('时长取数失败时静默降级为「暂无数据」，不影响概览（拒绝 settle 后才断言）', async () => {
    // 组件在「请求进行中」与「请求已失败」两种状态下渲染的是同一段「暂无数据」，
    // 单看 DOM 无法区分。这里用**可控的 rejected promise** 驱动，显式等拒绝被消化后再断言，
    // 保证断言不可能在请求仍 in-flight 时（假性）通过。
    let rejectStudy!: (reason?: unknown) => void;
    let rejectUsage!: (reason?: unknown) => void;
    const studyPromise = new Promise<ParentStudyTime>((_, reject) => {
      rejectStudy = reject;
    });
    const usagePromise = new Promise<ParentTodayUsage>((_, reject) => {
      rejectUsage = reject;
    });
    getStudyTimeMock.mockReturnValue(studyPromise);
    getTodayUsageMock.mockReturnValue(usagePromise);

    renderAt('/parent/dashboard');
    await screen.findByTestId('dashboard-student-11');

    // 此时请求尚未 reject（仍 in-flight），「暂无数据」也只是未设值的结果。
    rejectStudy(new Error('study boom'));
    rejectUsage(new Error('usage boom'));
    await flushMicrotasks();

    const card = screen.getByTestId('dashboard-study-time-11');
    expect(card.textContent).toContain('暂无数据');
    // 概览主体仍在
    expect(screen.getByTestId('dashboard-student-11')).toBeTruthy();
  });

  it('窗口内零会话 → 两张卡都显示「暂无数据」，绝不出现「不足 1 分钟」', async () => {
    // 端点**总会**返回对象（totalSeconds / activeSeconds 是普通数字，契约里没有「无数据」信号），
    // 所以「没有会话」只能靠数组判空。用 deferred + act 保证这份零会话响应已落到 state，
    // 否则断言会落在「请求还没回来」的 null 空态上——那条路和修复前长得一样，测不出回归。
    let resolveStudy!: (v: ParentStudyTime) => void;
    let resolveUsage!: (v: ParentTodayUsage) => void;
    getStudyTimeMock.mockImplementation(
      () =>
        new Promise<ParentStudyTime>((res) => {
          resolveStudy = res;
        }),
    );
    getTodayUsageMock.mockImplementation(
      () =>
        new Promise<ParentTodayUsage>((res) => {
          resolveUsage = res;
        }),
    );

    renderAt('/parent/dashboard');
    await screen.findByTestId('dashboard-student-11');
    await waitFor(() => expect(getStudyTimeMock).toHaveBeenCalled());

    await act(async () => {
      resolveStudy({
        totalSeconds: 0, activeDays: 0, byDay: [], byModule: [], bySubject: [], source: 'sessions',
      });
      resolveUsage({
        date: '2026-09-19', activeSeconds: 0, byModule: [],
      });
    });

    const studyCard = screen.getByTestId('dashboard-study-time-11');
    const usageCard = screen.getByTestId('dashboard-today-usage-11');
    expect(studyCard).toHaveTextContent('暂无数据');
    expect(usageCard).toHaveTextContent('暂无数据');
    // 零会话格式化成「不足 1 分钟」会把「什么都没学」读成「学了点」。
    expect(studyCard).not.toHaveTextContent('不足 1 分钟');
    expect(usageCard).not.toHaveTextContent('不足 1 分钟');
    // 概览主体照常渲染
    expect(screen.getByTestId('dashboard-student-11')).toBeTruthy();
  });

  it('切孩子：时长按 studentId 归属派生，绝不带出上一个孩子的时长', async () => {
    // 两个孩子时长刻意不同且格式化后不同：5400 → 「1 小时 30 分」；600 → 「10 分钟」。
    // 小美的请求挂在一个**我们不主动 resolve 的 deferred** 上，制造出「已切到小美、数据未到」
    // 的那一帧——这正是派生若忽略 studentId 会把小明时长画到小美卡上的时刻。
    let resolveGirlStudy!: (value: ParentStudyTime) => void;
    const girlStudy = new Promise<ParentStudyTime>((resolve) => {
      resolveGirlStudy = resolve;
    });
    getStudyTimeMock.mockImplementation((id: number) =>
      id === 11 ? Promise.resolve(studyTime(5400)) : girlStudy,
    );

    renderAt('/parent/dashboard');
    await waitFor(() =>
      expect(screen.getByTestId('dashboard-study-time-11').textContent).toContain('1 小时 30 分'),
    );

    fireEvent.click(screen.getByRole('tab', { name: '小美' }));

    // 小美数据未到：绝不能出现小明（上一个孩子）的时长。
    expect(screen.getByTestId('dashboard-study-time-12').textContent).not.toContain('1 小时 30 分');

    resolveGirlStudy(studyTime(600));
    await waitFor(() =>
      expect(screen.getByTestId('dashboard-study-time-12').textContent).toContain('10 分钟'),
    );
    expect(screen.getByTestId('dashboard-study-time-12').textContent).not.toContain('1 小时 30 分');
  });
});
