import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MobileDashboardPage from './MobileDashboardPage';
import { useParentStudentStore } from '@/store/parentStudentStore';

afterEach(() => {
  cleanup();
  useParentStudentStore.setState({ studentId: 1 });
});

vi.mock('@/services/api', () => ({
  getParentDashboard: vi.fn(),
  getParentStudyTime: vi.fn(),
  getParentTodayUsage: vi.fn(),
  getParentMastery: vi.fn(),
}));
import {
  getParentDashboard,
  getParentStudyTime,
  getParentTodayUsage,
  getParentMastery,
} from '@/services/api';

/**
 * mock 形状以 `api.ts` 真源为准（brief 原稿的 `subjects[].name` / `progress: number`
 * / `accuracy: number` 与真源不符，已按 ⚠️ 规则修正）：
 * - `ParentDashboardSubject.subjectName`（不是 name）；
 * - `progress` 是对象，进度% 取 `progress.percent`；
 * - `accuracy` 是 `ParentRateSummary`，`rate` 已是 0–100 百分比，null = 暂无数据。
 */
const dash = {
  students: [{
    studentId: 1, name: '小明', grade: '四年级', schoolLevel: 'primary',
    lastActiveAt: '2026-10-01T10:00:00Z', activeDays7: 3, unreadAlerts: 0,
    subjects: [{
      subjectId: 2,
      subjectName: '数学',
      progress: { completedUnits: 2, totalUnits: 5, currentUnitName: null, currentLessonName: null, percent: 40 },
      accuracy: { answered: 10, correct: 8, rate: 80 },
      selfAssessed: { count: 0, correctCount: 0 },
      errorBook: { uncleared: 0, total: 0 },
      examCount: 0,
    }],
  }],
  unreadAlerts: 0,
};
const study = {
  totalSeconds: 3600, activeDays: 2, byDay: [], byModule: [],
  bySubject: [{ subjectId: 2, seconds: 3600 }], source: 'sessions' as const,
};
const usage = { date: '2026-10-01', activeSeconds: 1200, byModule: [] };
const mastery = { items: [{ knowledgePointId: 7, name: '分数运算', masteryScore: 0.4, level: 1, correctCount: 2, errorCount: 3, lastSeenAt: null }], coveredQuestions: 38, totalQuestions: 100, uncovered: 62 };

// 孩子 2 的仪表盘（竞态用例）：形状与 dash 同构，仅身份与名字不同。
const dash2 = {
  students: [{
    studentId: 2, name: '小红', grade: '五年级', schoolLevel: 'primary',
    lastActiveAt: '2026-10-01T11:00:00Z', activeDays7: 5, unreadAlerts: 0,
    subjects: [{
      subjectId: 2,
      subjectName: '数学',
      progress: { completedUnits: 4, totalUnits: 5, currentUnitName: null, currentLessonName: null, percent: 80 },
      accuracy: { answered: 9, correct: 9, rate: 100 },
      selfAssessed: { count: 0, correctCount: 0 },
      errorBook: { uncleared: 0, total: 0 },
      examCount: 0,
    }],
  }],
  unreadAlerts: 0,
};

describe('MobileDashboardPage', () => {
  beforeEach(() => {
    // store 初始 studentId 为 null（未选孩子态），页面此时不拉数据；
    // 三个用例都基于「已选中 1 号孩子」的场景，统一在此置入。
    useParentStudentStore.setState({ studentId: 1 });
  });

  it('三卡渲染：进度/时长/薄弱点，口径文案分开', async () => {
    vi.mocked(getParentDashboard).mockResolvedValue(dash as never);
    vi.mocked(getParentStudyTime).mockResolvedValue(study as never);
    vi.mocked(getParentTodayUsage).mockResolvedValue(usage as never);
    vi.mocked(getParentMastery).mockResolvedValue(mastery as never);
    render(<MobileDashboardPage />);
    expect(await screen.findByText(/数学/)).toBeTruthy();
    // 断言语义（brief ⚠️）：进度%、正确率%（mock：percent 40 / rate 80）
    expect(screen.getByText(/进度 40%/)).toBeTruthy();
    expect(screen.getByText(/正确率 80%/)).toBeTruthy();
    // 硬约定：会话时长与活跃天数是两套口径，文案必须分别出现
    expect(screen.getByTestId('study-time-sessions')).toBeTruthy();
    expect(screen.getByTestId('active-days-7')).toBeTruthy();
    // 覆盖率三计数一起展示（ParentMastery 硬注释）
    expect(screen.getByText(/38\/100/)).toBeTruthy();
  });

  it('快速切孩子：旧孩子在途响应 resolve 后不得覆盖新孩子、不得卡骨架屏（竞态守卫）', async () => {
    // 与 MobileControlsPage.test 的同构用例：孩子 1 的 dashboard 挂在 deferred 上，
    // 制造「已切走、旧响应在途」。无守卫时旧响应写回 → ownerId=1 ≠ studentId=2
    // 永真 → 永久骨架屏（页面内无自救）。
    let resolveBoy!: (value: typeof dash) => void;
    const boyDash = new Promise<typeof dash>((resolve) => { resolveBoy = resolve; });
    vi.mocked(getParentDashboard).mockResolvedValueOnce(boyDash as never).mockResolvedValueOnce(dash2 as never);
    vi.mocked(getParentStudyTime).mockResolvedValue(study as never);
    vi.mocked(getParentTodayUsage).mockResolvedValue(usage as never);
    vi.mocked(getParentMastery).mockResolvedValue(mastery as never);

    render(<MobileDashboardPage />);
    // 孩子 1 的数据未到就切到孩子 2
    act(() => { useParentStudentStore.setState({ studentId: 2 }); });
    // 孩子 2 的数据正常到达（没被旧请求卡死）
    expect(await screen.findByText(/小红/)).toBeTruthy();
    // 旧孩子的响应这时才 resolve —— 守卫必须把它整个丢弃
    await act(async () => {
      resolveBoy(dash);
    });
    // 仍显示孩子 2 的数据：没被「小明」覆盖，也没掉回骨架屏
    expect(screen.getByText(/小红/)).toBeTruthy();
    expect(screen.queryByText(/小明/)).toBeNull();
    expect(screen.queryByTestId('dashboard-skeleton')).toBeNull();
  });

  it('studentId 变化整页重拉', async () => {
    vi.mocked(getParentDashboard).mockResolvedValue(dash as never);
    vi.mocked(getParentStudyTime).mockResolvedValue(study as never);
    vi.mocked(getParentTodayUsage).mockResolvedValue(usage as never);
    vi.mocked(getParentMastery).mockResolvedValue(mastery as never);
    render(<MobileDashboardPage />);
    await screen.findByText(/数学/);
    vi.mocked(getParentDashboard).mockClear();
    vi.mocked(getParentStudyTime).mockClear();
    useParentStudentStore.setState({ studentId: 2 });
    await waitFor(() => expect(getParentStudyTime).toHaveBeenCalledWith(2, expect.anything()));
  });

  it('拉取失败显示错误重试', async () => {
    vi.mocked(getParentDashboard).mockRejectedValue(new Error('x'));
    vi.mocked(getParentStudyTime).mockRejectedValue(new Error('x'));
    vi.mocked(getParentTodayUsage).mockRejectedValue(new Error('x'));
    vi.mocked(getParentMastery).mockRejectedValue(new Error('x'));
    render(<MobileDashboardPage />);
    expect(await screen.findByTestId('dashboard-retry')).toBeTruthy();
    vi.mocked(getParentDashboard).mockResolvedValue(dash as never);
    vi.mocked(getParentStudyTime).mockResolvedValue(study as never);
    vi.mocked(getParentTodayUsage).mockResolvedValue(usage as never);
    vi.mocked(getParentMastery).mockResolvedValue(mastery as never);
    await userEvent.click(screen.getByTestId('dashboard-retry'));
    expect(await screen.findByText(/数学/)).toBeTruthy();
  });
});
