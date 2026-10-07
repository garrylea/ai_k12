import { useEffect, useState } from 'react';
import ChartBar from '@/components/business/parent/ChartBar';
import ChartLine from '@/components/business/parent/ChartLine';
import {
  getParentReport,
  getParentStudyTime,
  type ParentLearningReport,
  type ParentReportPeriod,
  type ParentStudyTime,
} from '@/services/api';
import { formatDuration } from '@/utils/duration';
import { useParentStudentStore } from '@/store/parentStudentStore';

type LoadStatus = 'loading' | 'ready' | 'error';

/** `2026-09-28` → `09-28`（与桌面 ParentReportPage 同口径：X 轴太窄放不下年份）。 */
function shortDay(date: string): string {
  return date.slice(5);
}

function formatRate(rate: number | null): string {
  return rate === null ? '暂无数据' : `${rate}%`;
}

/**
 * /m/parent/report 学习报告（weekly/monthly 切换 + 趋势折线 / 学科柱状）。
 *
 * 取数方式以桌面 `ParentReportPage.tsx` 为真源：
 * - 报告先行，学习时长等报告回来拿服务端算的 `windowStart/windowEnd` 二次拉取
 *   （前端不重复实现窗口逻辑）；时长是**增值信息**，取不到整块不渲染、不打断报告。
 * - 会话时长与活跃天数是**两套口径**，并列展示、文案区分（spec §10 硬约定）。
 * - 薄弱知识点行是 `{ name, unclearedCount, totalWrongCount }`（api.ts 真源，
 *   brief 草稿的 knowledgePointName/errorCount 是错的）；未覆盖条数必须显式提示口径。
 *
 * `data-testid="mobile-page-report"` 挂**所有状态共用的外层容器**（路由测试渲染时
 * store 的 studentId 可能为 null），不是只在 ready 分支。
 */
export default function MobileReportPage() {
  const studentId = useParentStudentStore((s) => s.studentId);
  const [period, setPeriod] = useState<ParentReportPeriod>('weekly');
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [report, setReport] = useState<ParentLearningReport | null>(null);
  const [study, setStudy] = useState<{ studentId: number; period: ParentReportPeriod; value: ParentStudyTime } | null>(null);
  /** 带归属：只渲染与当前 studentId 同源的数据，切换期间不显示上个孩子的。 */
  const [ownerId, setOwnerId] = useState<number | null>(null);
  const [reload, setReload] = useState(0);

  /** 与报告同一条纪律：值按 `studentId + period` 现算，不在 effect 里清空。 */
  const studyValue =
    study && study.studentId === studentId && study.period === period ? study.value : null;

  useEffect(() => {
    if (studentId === null) return;
    // 竞态守卫（MobileControlsPage/MobileGoalsPage cancelled 模式）：
    // 换孩/切周期后旧响应晚到不许写回——cleanup 置 cancelled 丢弃旧包。
    let cancelled = false;
    setStatus('loading');
    getParentReport(studentId, period)
      .then((res) => {
        if (cancelled) return;
        setReport(res);
        setOwnerId(studentId);
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [studentId, period, reload]);

  useEffect(() => {
    // 窗口要等报告回来才知道（服务端算的）；报告不属于当前 studentId+period 时不拉
    if (studentId === null || report === null || report.studentId !== studentId || report.period !== period) return;
    let cancelled = false;
    void getParentStudyTime(studentId, report.windowStart, report.windowEnd)
      .then((res) => {
        if (cancelled) return;
        setStudy({ studentId, period, value: res });
      })
      .catch(() => {
        // 增值信息：取不到就不渲染时长块，不打断报告主体（与桌面同口径）
      });
    return () => {
      cancelled = true;
    };
  }, [studentId, period, report]);

  if (studentId === null) {
    return (
      <div data-testid="mobile-page-report">
        <p className="text-[var(--text-secondary)]">先在上方选择孩子</p>
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div data-testid="mobile-page-report">
        <div className="rounded-2xl bg-white p-8 text-center">
          <p className="text-[var(--text-secondary)]">加载失败</p>
          <button data-testid="report-retry" onClick={() => setReload((n) => n + 1)} className="mt-2 text-[var(--brand-500)]">重试</button>
        </div>
      </div>
    );
  }
  if (status === 'loading' || ownerId !== studentId || report === null) {
    return (
      <div data-testid="mobile-page-report">
        <div className="h-24 animate-pulse rounded-2xl bg-white" />
      </div>
    );
  }

  return (
    <div data-testid="mobile-page-report" className="space-y-3">
      <div className="flex gap-2">
        {(['weekly', 'monthly'] as const).map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={period === p}
            data-testid={`report-period-${p}`}
            onClick={() => setPeriod(p)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium ${period === p ? 'bg-[var(--brand-500)] text-white' : 'bg-white text-[var(--text-secondary)]'}`}
          >
            {p === 'weekly' ? '本周' : '本月'}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-2xl bg-white p-4">
          <p className="text-xs text-[var(--text-tertiary)]">答题数</p>
          <p className="text-lg font-bold">{report.stats.answered}</p>
        </div>
        <div className="rounded-2xl bg-white p-4">
          <p className="text-xs text-[var(--text-tertiary)]">正确率</p>
          {/* rate 为 null = 本期没有可判对错的作答，不是 0% */}
          <p className="text-lg font-bold">{formatRate(report.stats.rate)}</p>
        </div>
      </div>
      <div className="rounded-2xl bg-white p-4">
        <h2 className="mb-3 text-base font-bold">正确率趋势</h2>
        <ChartLine
          points={report.trend
            // rate 为 null 的点（当天只有主观自评）跳过——画成 0 会被读成「全错」
            .filter((t) => t.rate !== null)
            .map((t) => ({ label: shortDay(t.date), value: t.rate as number }))}
          emptyText="本期还没有答题记录"
        />
      </div>
      <div className="rounded-2xl bg-white p-4">
        <h2 className="mb-3 text-base font-bold">各学科答题量</h2>
        <ChartBar
          points={report.subjects.map((s) => ({ label: `${s.subjectName} ${formatRate(s.rate)}`, value: s.answered }))}
          emptyText="本期还没有答题记录"
        />
      </div>
      <div className="rounded-2xl bg-white p-4 text-sm">
        <h2 className="mb-2 text-base font-bold">学习时长</h2>
        {studyValue && (
          <p>
            <span data-testid="report-study-time">会话口径 {formatDuration(studyValue.totalSeconds)}</span>
            {' · '}
            <span data-testid="report-active-days">有学习 {studyValue.activeDays} 天</span>
          </p>
        )}
        <p className="mt-1 text-xs text-[var(--text-tertiary)]">口径说明：时长按学习会话统计；天数按有记录的天数统计，两者独立计算。</p>
      </div>
      <div className="rounded-2xl bg-white p-4 text-sm">
        <h2 className="mb-2 text-base font-bold">薄弱知识点</h2>
        {report.weakPoints.length === 0 ? (
          <p className="text-[var(--text-secondary)]">暂无薄弱点记录</p>
        ) : (
          <ul className="space-y-1">
            {report.weakPoints.map((w) => (
              <li key={w.knowledgePointId} className="flex justify-between">
                <span>{w.name}</span>
                <span>{`未清零 ${w.unclearedCount} 道 / 共错 ${w.totalWrongCount} 道`}</span>
              </li>
            ))}
          </ul>
        )}
        {/* 覆盖不到知识点的错题必须显式说清，否则家长会以为「只有这几个问题」 */}
        {report.weakPointsUncoveredCount > 0 && (
          <p data-testid="report-uncovered-hint" className="mt-2 text-xs text-[var(--text-tertiary)]">
            {`另有 ${report.weakPointsUncoveredCount} 道未清零错题尚未标注知识点，未计入上面的统计。`}
          </p>
        )}
      </div>
    </div>
  );
}
