import { useEffect, useState } from 'react';
import { getAdminRetention, type RetentionData } from '@/services/api';
import { toast } from '@/components/base';
import { AnalyticsPageShell, useAdminAnalyticsWindow, fmtPct } from './shared';

/** 默认同期群起点：30 天前（当天的 cohort 几乎无留存数据可看）。 */
function defaultCohortStart(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 埋点 Phase 2 · 留存分析（delta spec §7 Task 15）。
 * 同期群（首活跃日）日期输入 + 留存表：cohortSize、每行 第 N 天 / 仍活跃 / 留存率。
 */
export default function AnalyticsRetentionPage() {
  const w = useAdminAnalyticsWindow();
  const [cohortStart, setCohortStart] = useState<string>(defaultCohortStart);
  const [data, setData] = useState<RetentionData | null>(null);

  useEffect(() => {
    if (!cohortStart) return;
    let cancelled = false;
    getAdminRetention(cohortStart)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => toast('error', e instanceof Error ? e.message : '加载失败'));
    return () => {
      cancelled = true;
    };
  }, [cohortStart]);

  return (
    <AnalyticsPageShell
      title="留存分析"
      description="同一批学生在后续天数里还回来多少"
      window={w}
      onWindowChange={(next) => {
        w.setFrom(next.from);
        w.setTo(next.to);
      }}
    >
      <div>
        <input
          type="date"
          aria-label="同期群首活跃日"
          value={cohortStart}
          onChange={(e) => setCohortStart(e.target.value)}
          className="bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm"
          style={{ color: 'var(--text-primary)' }}
        />
      </div>
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm" data-testid="retention-table">
          <thead>
            <tr className="border-b border-gray-200 text-left" style={{ color: 'var(--text-secondary)' }}>
              <th className="px-4 py-3 font-medium">同期群人数</th>
              <th className="px-4 py-3 font-medium">第 N 天</th>
              <th className="px-4 py-3 font-medium">仍活跃</th>
              <th className="px-4 py-3 font-medium">留存率</th>
            </tr>
          </thead>
          <tbody>
            {data && data.days.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center" style={{ color: 'var(--text-secondary)' }}>
                  暂无数据
                </td>
              </tr>
            )}
            {data && data.days.length > 0 && (
              <tr data-testid="retention-cohort">
                <td rowSpan={data.days.length} className="px-4 py-3 font-bold" style={{ color: 'var(--text-primary)' }}>
                  {data.cohortSize}
                </td>
              </tr>
            )}
            {data?.days.map((d) => (
              <tr key={d.offset} className="border-b border-gray-200 last:border-b-0" data-testid={`retention-day-${d.offset}`}>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{d.offset}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{d.retained}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{fmtPct(d.rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AnalyticsPageShell>
  );
}
