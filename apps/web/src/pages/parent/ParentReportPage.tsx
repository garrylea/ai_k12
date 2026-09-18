import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { Button, Card, Skeleton } from '@/components/base';
import ChartLine from '@/components/business/parent/ChartLine';
import ChartBar from '@/components/business/parent/ChartBar';
import {
  ApiError,
  getParentReport,
  type ParentLearningReport,
  type ParentReportPeriod,
} from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';

const PERIODS: Array<{ key: ParentReportPeriod; label: string }> = [
  { key: 'weekly', label: '周报' },
  { key: 'monthly', label: '月报' },
];

function formatRate(rate: number | null): string {
  return rate === null ? '暂无数据' : `${rate}%`;
}

/** `2026-09-15` → `09-15`（折线 X 轴太窄，放不下年份）。 */
function shortDay(date: string): string {
  return date.slice(5);
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-card)] bg-[var(--bg-subtle)] p-3">
      <div className="text-xs text-[var(--text-tertiary)]">{label}</div>
      <div className="mt-1 text-lg font-bold text-[var(--text-primary)]">{value}</div>
    </div>
  );
}

export default function ParentReportPage() {
  const studentId = useParentStudentStore((s) => s.studentId);
  const [period, setPeriod] = useState<ParentReportPeriod>('weekly');
  const [report, setReport] = useState<{ studentId: number; period: ParentReportPeriod; value: ParentLearningReport } | null>(null);
  const [failure, setFailure] = useState<{ studentId: number; code: number | null } | null>(null);
  const [reload, setReload] = useState(0);

  /**
   * 数据按 `studentId + period` 现算，而不是在 effect 里 setReport(null)：
   * effect 在 commit 之后才跑，清空会慢一帧——那一帧页面上是**上一个孩子/上一档**的报告。
   */
  const data =
    report && report.studentId === studentId && report.period === period ? report.value : null;
  const err = failure && failure.studentId === studentId ? failure : null;

  useEffect(() => {
    if (studentId === null) return;
    let cancelled = false;
    getParentReport(studentId, period)
      .then((res) => {
        if (cancelled) return;
        setReport({ studentId, period, value: res });
        setFailure(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setReport(null);
        setFailure({ studentId, code: error instanceof ApiError ? error.code : null });
      });
    return () => {
      cancelled = true;
    };
  }, [studentId, period, reload]);

  if (studentId === null) {
    return (
      <Card data-testid="report-no-student" className="p-10 text-center">
        <p className="text-sm text-[var(--text-secondary)]">还没有选择孩子账号</p>
        <Link
          to="/parent/students"
          className="mt-3 inline-block text-sm font-medium text-[var(--brand-600)] hover:underline"
        >
          去创建学生账号
        </Link>
      </Card>
    );
  }

  return (
    <div>
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black text-[var(--text-primary)]">学情报告</h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            {data ? `${data.windowStart} 至 ${data.windowEnd}` : '按学科与时间查看学习表现'}
          </p>
        </div>
        <div className="flex gap-2">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              type="button"
              aria-pressed={period === p.key}
              onClick={() => setPeriod(p.key)}
              className={clsx(
                'px-4 py-1.5 rounded-full text-sm font-medium border transition-colors',
                period === p.key
                  ? 'border-[var(--brand-500)] bg-[var(--brand-100)] text-[var(--brand-600)]'
                  : 'border-[var(--bg-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </header>

      {err?.code === 1002 ? (
        <Card data-testid="report-student-missing" className="p-10 text-center">
          <p className="text-sm text-[var(--text-secondary)]">
            该孩子账号不存在，请在顶部切换其它孩子
          </p>
        </Card>
      ) : err?.code === 1005 ? (
        <Card data-testid="report-student-forbidden" className="p-10 text-center">
          <p className="text-sm text-[var(--text-secondary)]">无权查看该孩子</p>
        </Card>
      ) : err ? (
        <Card
          data-testid="report-error"
          className="flex flex-wrap items-center justify-between gap-4 border border-[var(--error)] p-4"
        >
          <span className="text-sm text-[var(--text-secondary)]">学情报告暂时加载失败</span>
          <Button variant="secondary" size="sm" onClick={() => setReload((n) => n + 1)}>
            重试
          </Button>
        </Card>
      ) : data === null ? (
        <div data-testid="report-skeleton" className="space-y-4">
          <Skeleton width="100%" height={92} rounded />
          <Skeleton width="100%" height={220} rounded />
        </div>
      ) : (
        <div className="space-y-5">
          <Card className="p-5">
            <div data-testid="report-stats" className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard label="正确率" value={formatRate(data.stats.rate)} />
              <StatCard label="答题数" value={String(data.stats.answered)} />
              <StatCard label="活跃天数" value={String(data.stats.activeDays)} />
              <StatCard label="自评次数" value={String(data.stats.selfAssessCount)} />
              <StatCard label="新进错题本" value={String(data.stats.errorsAdded)} />
              <StatCard label="清零错题" value={String(data.stats.errorsCleared)} />
              <StatCard label="考试场次" value={String(data.stats.examCount)} />
            </div>
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 text-base font-bold text-[var(--text-primary)]">正确率趋势</h2>
            <ChartLine
              points={data.trend
                // rate 为 null 的点（当天只有主观自评）跳过——画成 0 会被读成「全错」
                .filter((t) => t.rate !== null)
                .map((t) => ({ label: shortDay(t.date), value: t.rate as number }))}
              emptyText="本期还没有答题记录"
            />
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 text-base font-bold text-[var(--text-primary)]">各学科答题量</h2>
            <ChartBar
              points={data.subjects.map((s) => ({
                label: `${s.subjectName} ${formatRate(s.rate)}`,
                value: s.answered,
              }))}
              emptyText="本期还没有答题记录"
            />
          </Card>

          <Card className="p-5" data-testid="report-weak-points">
            <h2 className="mb-3 text-base font-bold text-[var(--text-primary)]">薄弱知识点</h2>
            {data.weakPoints.length === 0 ? (
              <p className="text-sm text-[var(--text-secondary)]">暂无薄弱点数据</p>
            ) : (
              <ul className="space-y-2">
                {data.weakPoints.map((w) => (
                  <li
                    key={w.knowledgePointId}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="text-[var(--text-primary)]">{w.name}</span>
                    <span className="text-[var(--text-secondary)]">
                      {`未清零 ${w.unclearedCount} 道 / 共错 ${w.totalWrongCount} 道`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {/* 覆盖不到知识点的错题必须显式说清，否则家长会以为「只有这几个问题」 */}
            {data.weakPointsUncoveredCount > 0 && (
              <p
                data-testid="report-uncovered-hint"
                className="mt-3 text-xs text-[var(--text-tertiary)]"
              >
                {`另有 ${data.weakPointsUncoveredCount} 道未清零错题尚未标注知识点，未计入上面的统计。`}
              </p>
            )}
          </Card>

          <Card className="p-5" data-testid="report-exams">
            <h2 className="mb-3 text-base font-bold text-[var(--text-primary)]">考试记录</h2>
            {data.exams.length === 0 ? (
              <p className="text-sm text-[var(--text-secondary)]">还没有考试记录</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-[var(--text-tertiary)]">
                    <th className="pb-2 font-medium">试卷</th>
                    <th className="pb-2 font-medium">学科</th>
                    <th className="pb-2 font-medium">交卷时间</th>
                    <th className="pb-2 font-medium">正确率</th>
                  </tr>
                </thead>
                <tbody>
                  {data.exams.map((e) => (
                    <tr key={e.sessionId} className="border-t border-[var(--bg-subtle)]">
                      <td className="py-2 text-[var(--text-primary)]">{e.paperTitle}</td>
                      <td className="py-2 text-[var(--text-secondary)]">{e.subjectName}</td>
                      <td className="py-2 text-[var(--text-secondary)]">
                        {formatDateTime(e.submittedAt)}
                      </td>
                      <td className="py-2 text-[var(--text-primary)]">
                        {`${formatRate(e.rate)}（${e.correctCount}/${e.objectiveCount}）`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
