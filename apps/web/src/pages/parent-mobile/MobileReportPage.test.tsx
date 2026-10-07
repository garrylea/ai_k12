import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MobileReportPage from './MobileReportPage';
import { useParentStudentStore } from '@/store/parentStudentStore';

afterEach(() => {
  cleanup();
  useParentStudentStore.setState({ studentId: 1 });
});

/** 图表桩的入参形状（与 `ChartLine` / `ChartBar` 的 `ChartPoint` 一致）。 */
interface StubPoint {
  label: string;
  value: number;
}

/**
 * 图表被替换成轻量桩（与 ParentReportPage.test.tsx 同一先例）：`recharts` 在 jsdom
 * 里量不到尺寸、不真渲染 SVG。真实图表封装已由 `components/business/parent/*.test.tsx`
 * 覆盖；本文件只验页面的**数据编排**（给图表喂了什么、有没有正确处理 null）。
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

vi.mock('@/services/api', () => ({
  getParentReport: vi.fn(),
  getParentStudyTime: vi.fn(),
}));
import { getParentReport, getParentStudyTime } from '@/services/api';

/**
 * mock 形状以 `api.ts` 真源为准（brief 原稿的
 * `weakPoints[].knowledgePointName/errorCount` 与真源不符，已按 ⚠️ 规则修正）：
 * `ParentWeakPoint` = `{ knowledgePointId, name, unclearedCount, totalWrongCount }`。
 */
const report = {
  studentId: 1,
  period: 'weekly',
  windowStart: '2026-09-28',
  windowEnd: '2026-10-04',
  stats: {
    activeDays: 5, answered: 40, correct: 32, rate: 80,
    selfAssessCount: 2, errorsAdded: 3, errorsCleared: 5, examCount: 1,
  },
  trend: [
    { date: '2026-09-28', answered: 5, correct: 4, rate: 80 },
    { date: '2026-09-29', answered: 3, correct: 3, rate: 100 },
    // 只有主观自评的当天：rate 为 null，画成 0 会被读成「全错」，必须跳过
    { date: '2026-09-30', answered: 6, correct: 0, rate: null },
  ],
  subjects: [{ subjectId: 2, subjectName: '数学', answered: 14, correct: 11, rate: 78.6 }],
  weakPoints: [{ knowledgePointId: 7, name: '分数运算', unclearedCount: 3, totalWrongCount: 5 }],
  weakPointsUncoveredCount: 2,
  exams: [],
};
const study = {
  totalSeconds: 3600, activeDays: 2, byDay: [], byModule: [],
  bySubject: [], source: 'sessions' as const,
};

describe('MobileReportPage', () => {
  beforeEach(() => {
    useParentStudentStore.setState({ studentId: 1 });
  });

  it('渲染统计卡/趋势图/学科答题量/薄弱点口径', async () => {
    vi.mocked(getParentReport).mockResolvedValue(report as never);
    vi.mocked(getParentStudyTime).mockResolvedValue(study as never);
    render(<MobileReportPage />);
    // 统计卡（答题数 40；字符串精确匹配，避免数字碎片多命中）
    expect(await screen.findByText('40')).toBeTruthy();
    // 趋势折线：rate 为 null 的点（09-30 只有主观自评）必须被过滤——3 天只喂 2 个点
    expect(await screen.findByTestId('chart-line')).toBeTruthy();
    expect(screen.getByTestId('chart-line').getAttribute('data-count')).toBe('2');
    expect(screen.getByTestId('chart-line').textContent).toContain('09-28:80');
    // 学科柱状图：label = 学科名 + formatRate
    expect(screen.getByTestId('chart-bar')).toBeTruthy();
    expect(screen.getByTestId('chart-bar').textContent).toContain('数学 78.6%');
    // 薄弱点：真源字段 name + 未清零/共错 双计数
    expect(screen.getByText('分数运算')).toBeTruthy();
    expect(screen.getByText(/未清零 3 道 \/ 共错 5 道/)).toBeTruthy();
    // 覆盖率口径必须显式提示（弱映射不到知识点的条数 2）
    expect(screen.getByTestId('report-uncovered-hint').textContent).toContain('2');
    // 双口径并列：会话时长 + 有学习天数，文案分开
    expect(screen.getByTestId('report-study-time')).toBeTruthy();
    expect(screen.getByTestId('report-active-days')).toBeTruthy();
  });

  it('weekly/monthly 切换整页重拉', async () => {
    vi.mocked(getParentReport).mockResolvedValue(report as never);
    vi.mocked(getParentStudyTime).mockResolvedValue(study as never);
    render(<MobileReportPage />);
    await screen.findByText('40');
    await userEvent.click(screen.getByTestId('report-period-monthly'));
    await waitFor(() => expect(getParentReport).toHaveBeenLastCalledWith(1, 'monthly'));
  });

  it('拉取失败显示错误重试', async () => {
    vi.mocked(getParentReport).mockRejectedValue(new Error('x'));
    render(<MobileReportPage />);
    expect(await screen.findByTestId('report-retry')).toBeTruthy();
  });
});
