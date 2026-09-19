import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { routes } from '@/routes/routeTable';
import { getParentReport, getParentStudyTime, getParentMastery, getUnreadMessageCount, listMyStudents, type MyStudentItem, type ParentLearningReport, type ParentMastery, type ParentStudyTime } from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';
import { useThemeStore } from '@/store/themeStore';

/** 图表桩的入参形状（与 `ChartLine` / `ChartBar` 的 `ChartPoint` 一致）。 */
interface StubPoint {
  label: string;
  value: number;
}

/**
 * 图表被替换成轻量桩：`recharts` 在 jsdom 里量不到尺寸、不真渲染 SVG，
 * 真实图表封装的取色/空态已由 `components/business/parent/*.test.tsx` 覆盖。
 * 本文件只验页面的**数据编排**（给图表喂了什么、有没有正确处理 null）。
 */
vi.mock('@/components/business/parent/ChartLine', () => ({
  default: ({ points }: { points: StubPoint[] }) => (
    <div data-testid="chart-line" data-count={points.length}>
      {points.map((p) => `${p.label}:${p.value}`).join(',')}
    </div>
  ),
}));
vi.mock('@/components/business/parent/ChartBar', () => ({
  default: ({ points }: { points: StubPoint[] }) => (
    <div data-testid="chart-bar" data-count={points.length}>
      {points.map((p) => `${p.label}:${p.value}`).join(',')}
    </div>
  ),
}));

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    listMyStudents: vi.fn(),
    getUnreadMessageCount: vi.fn(),
    getParentReport: vi.fn(),
    getParentStudyTime: vi.fn(),
    // 真掌握度卡（埋点 Phase 1B）自己取数
    getParentMastery: vi.fn(),
  };
});

const listMyStudentsMock = vi.mocked(listMyStudents);
const getUnreadMock = vi.mocked(getUnreadMessageCount);
const getReportMock = vi.mocked(getParentReport);
const getStudyTimeMock = vi.mocked(getParentStudyTime);
const getMasteryMock = vi.mocked(getParentMastery);

const BOY: MyStudentItem = { id: 11, parentId: 3, username: 'xiaoming', name: '小明', age: 13, grade: '初一', schoolLevel: 'junior', isActive: true };

/** 真掌握度卡的默认数据（埋点 Phase 1B）：覆盖率三项按实测基线 203/530。 */
const MASTERY: ParentMastery = {
  items: [
    {
      knowledgePointId: 42, name: '分数加减', masteryScore: 0.5, level: 2,
      correctCount: 3, errorCount: 3, lastSeenAt: '2026-09-16T10:00:00.000Z',
    },
  ],
  coveredQuestions: 203,
  totalQuestions: 530,
  uncovered: 327,
};

const REPORT: ParentLearningReport = {
  studentId: 11,
  period: 'weekly',
  windowStart: '2026-09-12',
  windowEnd: '2026-09-18',
  stats: {
    activeDays: 3, answered: 42, correct: 31, rate: 73.8,
    selfAssessCount: 5, errorsAdded: 6, errorsCleared: 4, examCount: 2,
  },
  trend: [
    { date: '2026-09-15', answered: 10, correct: 7, rate: 70 },
    { date: '2026-09-16', answered: 6, correct: 6, rate: 100 },
  ],
  subjects: [{ subjectId: 1, subjectName: '数学', answered: 42, correct: 31, rate: 73.8 }],
  weakPoints: [
    { knowledgePointId: 42, name: '分数加减', unclearedCount: 3, totalWrongCount: 5 },
  ],
  weakPointsUncoveredCount: 8,
  exams: [
    {
      sessionId: 7, paperTitle: '2025 学年七年级上期中', subjectName: '数学',
      submittedAt: '2026-09-16T19:20:00.000Z', correctCount: 18, objectiveCount: 22, rate: 81.8,
    },
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

beforeEach(() => {
  localStorage.clear();
  useParentStudentStore.setState({ studentId: 11 });
  listMyStudentsMock.mockReset();
  listMyStudentsMock.mockResolvedValue([BOY]);
  getUnreadMock.mockReset();
  getUnreadMock.mockResolvedValue(0);
  getReportMock.mockReset();
  getReportMock.mockResolvedValue(REPORT);
  getStudyTimeMock.mockReset();
  getStudyTimeMock.mockResolvedValue({
    totalSeconds: 5400,
    activeDays: 2,
    byDay: [
      { date: '2026-09-15', seconds: 3600 },
      { date: '2026-09-16', seconds: 1800 },
    ],
    byModule: [{ module: 'mainline', seconds: 5400 }],
    bySubject: [{ subjectId: 1, seconds: 5400 }],
    source: 'sessions',
  });
  getMasteryMock.mockReset();
  getMasteryMock.mockResolvedValue(MASTERY);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useParentStudentStore.setState({ studentId: null });
  useThemeStore.setState({ mode: 'student-day' });
});

describe('ParentReportPage', () => {
  it('按锚点孩子取 weekly 报告并渲染数字卡', async () => {
    renderAt('/parent/report');

    expect(await screen.findByTestId('report-stats')).toHaveTextContent('73.8%');
    expect(screen.getByTestId('report-stats')).toHaveTextContent('活跃天数3');
    expect(getReportMock).toHaveBeenCalledWith(11, 'weekly');
    // 学习时长必须用**报告里服务端算出的窗口**去取：前端不自己推窗口（钉住数据来源）
    await waitFor(() =>
      expect(getStudyTimeMock).toHaveBeenCalledWith(
        REPORT.studentId,
        REPORT.windowStart,
        REPORT.windowEnd,
      ),
    );
  });

  it('切月报 → 用 monthly 重新拉取', async () => {
    renderAt('/parent/report');
    await screen.findByTestId('report-stats');

    fireEvent.click(screen.getByRole('button', { name: '月报' }));

    await waitFor(() => expect(getReportMock).toHaveBeenLastCalledWith(11, 'monthly'));
  });

  it('切档时请求未回来 → 出骨架，不残留上一档的内容（防「闪现旧数据」）', async () => {
    renderAt('/parent/report');
    // 先让周报正常到货
    expect(await screen.findByTestId('report-stats')).toHaveTextContent('73.8%');

    // 月报这次**悬着不 resolve**
    getReportMock.mockImplementation(() => new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: '月报' }));

    // 请求在飞：必须是骨架，且周报的数字不能再挂在屏上
    expect(await screen.findByTestId('report-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('report-stats')).not.toBeInTheDocument();
  });

  it('趋势折线喂的是 rate，标签是日期', async () => {
    renderAt('/parent/report');

    const line = await screen.findByTestId('chart-line');
    expect(line).toHaveTextContent('09-15:70,09-16:100');
  });

  it('趋势里 rate 为 null 的点被跳过（画成 0 会被家长读成「全错」）', async () => {
    getReportMock.mockResolvedValue({
      ...REPORT,
      trend: [
        { date: '2026-09-15', answered: 10, correct: 7, rate: 70 },
        { date: '2026-09-16', answered: 2, correct: 0, rate: null },
      ],
    });

    renderAt('/parent/report');

    const line = await screen.findByTestId('chart-line');
    expect(line).toHaveAttribute('data-count', '1');
    expect(line).toHaveTextContent('09-15:70');
  });

  it('薄弱点列表 + 「另有 N 道错题未标注知识点」提示', async () => {
    renderAt('/parent/report');

    const weak = await screen.findByTestId('report-weak-points');
    expect(weak).toHaveTextContent('分数加减');
    expect(weak).toHaveTextContent('3');
    expect(await screen.findByTestId('report-uncovered-hint')).toHaveTextContent('8');
  });

  it('薄弱点为空也要出「未标注」提示（否则家长以为没问题）', async () => {
    getReportMock.mockResolvedValue({ ...REPORT, weakPoints: [], weakPointsUncoveredCount: 8 });

    renderAt('/parent/report');

    expect(await screen.findByTestId('report-weak-points')).toHaveTextContent('暂无薄弱点数据');
    expect(screen.getByTestId('report-uncovered-hint')).toHaveTextContent('8');
  });

  it('考试表格列出卷名与正确率', async () => {
    renderAt('/parent/report');

    const exams = await screen.findByTestId('report-exams');
    expect(exams).toHaveTextContent('2025 学年七年级上期中');
    expect(exams).toHaveTextContent('81.8%');
  });

  it('全空报告 → 各区块出空态，不崩', async () => {
    getReportMock.mockResolvedValue({
      ...REPORT,
      stats: { activeDays: 0, answered: 0, correct: 0, rate: null, selfAssessCount: 0, errorsAdded: 0, errorsCleared: 0, examCount: 0 },
      trend: [], subjects: [], weakPoints: [], weakPointsUncoveredCount: 0, exams: [],
    });

    renderAt('/parent/report');

    expect(await screen.findByTestId('report-stats')).toHaveTextContent('暂无数据');
    expect(screen.getByTestId('chart-line')).toHaveAttribute('data-count', '0');
    expect(screen.getByTestId('report-exams')).toHaveTextContent('还没有考试记录');
    // 未标注数为 0 时不能渲染「另有 0 道…」提示
    expect(screen.queryByTestId('report-uncovered-hint')).not.toBeInTheDocument();
  });

  it('没有选孩子 → 空态引导，不发请求', async () => {
    // 必须让切换器拿到**空列表**：否则它会把锚点回落成第一个孩子，页面就开始取数了
    useParentStudentStore.setState({ studentId: null });
    listMyStudentsMock.mockResolvedValue([]);

    renderAt('/parent/report');

    expect(await screen.findByTestId('report-no-student')).toBeInTheDocument();
    expect(getReportMock).not.toHaveBeenCalled();
  });

  it('孩子不存在（1002）→ 引导切换孩子，不给重试', async () => {
    const { ApiError } = await import('@/services/api');
    getReportMock.mockRejectedValue(new ApiError(1002, '学生不存在'));

    renderAt('/parent/report');

    expect(await screen.findByTestId('report-student-missing')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
  });

  it('月报失败后切回周报 → 立刻不再挂错误卡（失败状态也按 studentId+period 区分）', async () => {
    const { ApiError } = await import('@/services/api');

    renderAt('/parent/report');
    expect(await screen.findByTestId('report-stats')).toHaveTextContent('73.8%');

    getReportMock.mockImplementation((_studentId, p) =>
      p === 'monthly' ? Promise.reject(new ApiError(500, '服务异常')) : Promise.resolve(REPORT),
    );
    fireEvent.click(screen.getByRole('button', { name: '月报' }));
    expect(await screen.findByTestId('report-error')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '周报' }));
    // 同步断言：切回来的那一帧不能再显示月报的错误卡
    expect(screen.queryByTestId('report-error')).not.toBeInTheDocument();
    expect(await screen.findByTestId('report-stats')).toHaveTextContent('73.8%');
  });

  it('学习时长与活跃天数并列；每日柱状图按窗口日期喂给 ChartBar', async () => {
    renderAt('/parent/report');
    await waitFor(() => expect(screen.getByTestId('report-study-time')).toBeTruthy());

    // 旧口径仍在一张独立卡里
    expect(screen.getByText('活跃天数')).toBeTruthy();
    // 新口径：数字卡 + 每日柱状
    expect(screen.getByText('学习时长（会话）')).toBeTruthy();
    expect(screen.getByText('1 小时 30 分')).toBeTruthy();

    // 报告页有两个 ChartBar，必须限定到学习时长卡内取
    const bars = within(screen.getByTestId('report-study-time')).getByTestId('chart-bar');
    expect(bars.getAttribute('data-count')).toBe('2');
    expect(bars.textContent).toContain('09-15:60'); // 3600s → 60 分钟
  });

  it('时长取数失败 → 该卡显示「暂无学习时长数据」，报告主体不受影响', async () => {
    getStudyTimeMock.mockRejectedValue(new Error('boom'));
    renderAt('/parent/report');
    await waitFor(() => expect(screen.getByTestId('report-study-time')).toBeTruthy());
    expect(screen.getByTestId('report-study-time').textContent).toContain('暂无学习时长数据');
    expect(screen.getByTestId('report-stats')).toBeTruthy();
  });

  it('窗口内没有会话 → 只出「暂无学习时长数据」，绝不出现「不足 1 分钟」', async () => {
    // 端点**总会**返回对象（totalSeconds 是普通数字，契约里没有「无数据」信号），
    // 所以「没有会话」只能靠 byDay 判空。用 deferred + act 保证这份响应已落到 state，
    // 否则断言会落在「请求还没回来」的 null 空态上——那条路和修复前的行为长得一样，测不出回归。
    let resolveStudy!: (v: ParentStudyTime) => void;
    getStudyTimeMock.mockImplementation(
      () =>
        new Promise<ParentStudyTime>((res) => {
          resolveStudy = res;
        }),
    );

    renderAt('/parent/report');
    await screen.findByTestId('report-stats');
    await waitFor(() => expect(getStudyTimeMock).toHaveBeenCalled());

    await act(async () => {
      resolveStudy({
        totalSeconds: 0, activeDays: 0, byDay: [], byModule: [], bySubject: [], source: 'sessions',
      });
    });

    const card = screen.getByTestId('report-study-time');
    expect(card).toHaveTextContent('暂无学习时长数据');
    expect(card).not.toHaveTextContent('不足 1 分钟');
    // 数字卡那格也不能把 0 格式化成「不足 1 分钟」——那是「学了点」的读法，真相是「什么都没学」
    expect(screen.queryByText('不足 1 分钟')).not.toBeInTheDocument();
    // 报告主体照常渲染
    expect(screen.getByTestId('report-stats')).toHaveTextContent('73.8%');
    expect(screen.getByTestId('report-weak-points')).toHaveTextContent('分数加减');
    expect(screen.getByTestId('report-exams')).toHaveTextContent('2025 学年七年级上期中');
  });

  /**
   * spec §10 硬约束：**真掌握度与薄弱知识点并存不替换**。
   * 两张卡、两个标题、两套口径（前者是 `student_knowledge_mastery`，后者是错题数代理）。
   * 这条用例的价值在于：谁要是「顺手统一」成一张卡，或者把旧卡删了，这里立刻红。
   */
  it('真掌握度与薄弱知识点**两张卡并存**，标题不同且各用自己的数据', async () => {
    renderAt('/parent/report');

    const weak = await screen.findByTestId('report-weak-points');
    const mastery = await screen.findByTestId('report-mastery');

    expect(weak).toHaveTextContent('薄弱知识点');
    expect(mastery).toHaveTextContent('真掌握度');
    // 各自的数据来源不同：薄弱点来自报告接口的 weakPoints，掌握度来自 /mastery
    expect(weak).toHaveTextContent('分数加减');
    expect(mastery).toHaveTextContent('掌握度 50%');
    expect(getMasteryMock).toHaveBeenCalledWith(11, 10);
    // 旧卡的「未标注知识点」提示一个字都没动
    expect(screen.getByTestId('report-uncovered-hint')).toBeInTheDocument();
  });
});
