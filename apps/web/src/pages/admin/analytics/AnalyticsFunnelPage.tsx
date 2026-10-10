import { useEffect, useState } from 'react';
import { getAdminFunnel, type FunnelData } from '@/services/api';
import { toast } from '@/components/base';
import { AnalyticsPageShell, useAdminAnalyticsWindow, fmtPct, eventLabel, FUNNEL_MODULES } from './shared';

/**
 * 埋点 Phase 2 · 漏斗分析（delta spec §7 Task 15）。
 * 8 个白名单模块下拉 + 步骤条：每步事件中文名 / 人数 / 相对上步转化（第一步 '—'）。
 */
export default function AnalyticsFunnelPage() {
  const w = useAdminAnalyticsWindow();
  const [module, setModule] = useState<string>('mainline');
  const [data, setData] = useState<FunnelData | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAdminFunnel({ from: w.from, to: w.to, module })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => toast('error', e instanceof Error ? e.message : '加载失败'));
    return () => {
      cancelled = true;
    };
  }, [w.from, w.to, module]);

  return (
    <AnalyticsPageShell
      title="漏斗分析"
      description="从进入学习到完成的关键步骤转化"
      window={w}
      onWindowChange={(next) => {
        w.setFrom(next.from);
        w.setTo(next.to);
      }}
    >
      <div>
        <select
          aria-label="模块"
          value={module}
          onChange={(e) => setModule(e.target.value)}
          className="bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm"
          style={{ color: 'var(--text-primary)' }}
        >
          {FUNNEL_MODULES.map((m) => (
            <option key={m} value={m}>{eventLabel(m)}</option>
          ))}
        </select>
      </div>
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm" data-testid="funnel-table">
          <thead>
            <tr className="border-b border-gray-200 text-left" style={{ color: 'var(--text-secondary)' }}>
              <th className="px-4 py-3 font-medium">步骤</th>
              <th className="px-4 py-3 font-medium">人数</th>
              <th className="px-4 py-3 font-medium">转化</th>
            </tr>
          </thead>
          <tbody>
            {data && data.steps.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center" style={{ color: 'var(--text-secondary)' }}>
                  暂无数据
                </td>
              </tr>
            )}
            {data?.steps.map((s, i) => (
              <tr key={s.event} className="border-b border-gray-200 last:border-b-0" data-testid={`funnel-step-${s.event}`}>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{eventLabel(s.event)}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{s.students}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{i === 0 ? '—' : fmtPct(data.conversions[i] ?? null)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AnalyticsPageShell>
  );
}
