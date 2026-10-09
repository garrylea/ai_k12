import { useEffect, useState } from 'react';
import { getAdminOverview, type OverviewData } from '@/services/api';
import ChartBar from '@/components/business/parent/ChartBar';
import { toast } from '@/components/base';
import { AnalyticsPageShell, useAdminAnalyticsWindow, fmtPct, fmtDuration } from './shared';

/**
 * 埋点 Phase 2 · 数据总览（delta spec §7 Task 15）。
 * 4 张指标卡 + 各模块学习人数柱状图；取数模式照 AdminModelsPage（cancelled flag + toast）。
 */
export default function AnalyticsOverviewPage() {
  const w = useAdminAnalyticsWindow();
  const [data, setData] = useState<OverviewData | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAdminOverview({ from: w.from, to: w.to })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => toast('error', e instanceof Error ? e.message : '加载失败'));
    return () => {
      cancelled = true;
    };
  }, [w.from, w.to]);

  const cards = [
    { label: '今日活跃', value: data ? String(data.dau) : '…' },
    { label: '周活跃', value: data ? String(data.wau) : '…' },
    { label: '总时长', value: data ? fmtDuration(data.totalSeconds) : '…' },
    { label: '正确率', value: data ? fmtPct(data.accuracy) : '…' },
  ];

  return (
    <AnalyticsPageShell
      title="数据总览"
      description="多少人学、学多久、答多少"
      window={w}
      onWindowChange={(next) => {
        w.setFrom(next.from);
        w.setTo(next.to);
      }}
    >
      <div className="grid grid-cols-4 gap-4">
        {cards.map((c) => (
          <div key={c.label} className="bg-white rounded-2xl border border-gray-200 p-6" data-testid={`card-${c.label}`}>
            <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>{c.label}</div>
            <div className="text-2xl font-black" style={{ color: 'var(--text-primary)' }}>{c.value}</div>
          </div>
        ))}
      </div>
      {data && data.moduleTop.length > 0 && (
        <ChartBar points={data.moduleTop.map((m) => ({ label: m.module, value: m.students }))} emptyText="暂无数据" />
      )}
      {data && data.moduleTop.length === 0 && <p style={{ color: 'var(--text-secondary)' }}>暂无数据</p>}
    </AnalyticsPageShell>
  );
}
