import { useEffect, useState } from 'react';
import { getAdminModules, type ModulesData } from '@/services/api';
import { toast } from '@/components/base';
import { AnalyticsPageShell, useAdminAnalyticsWindow, fmtPct, fmtDuration, eventLabel } from './shared';

/**
 * 埋点 Phase 2 · 模块分析（delta spec §7 Task 15）。
 * 每模块一行：人数 / 时长 / 答题 / 正确数 / 正确率；空数组 → 「暂无数据」行（禁反向误读文案）。
 */
export default function AnalyticsModulesPage() {
  const w = useAdminAnalyticsWindow();
  const [data, setData] = useState<ModulesData | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAdminModules({ from: w.from, to: w.to })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => toast('error', e instanceof Error ? e.message : '加载失败'));
    return () => {
      cancelled = true;
    };
  }, [w.from, w.to]);

  return (
    <AnalyticsPageShell
      title="模块分析"
      description="各模块的学习人数与作答情况"
      window={w}
      onWindowChange={(next) => {
        w.setFrom(next.from);
        w.setTo(next.to);
      }}
    >
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm" data-testid="modules-table">
          <thead>
            <tr className="border-b border-gray-200 text-left" style={{ color: 'var(--text-secondary)' }}>
              <th className="px-4 py-3 font-medium">模块</th>
              <th className="px-4 py-3 font-medium">人数</th>
              <th className="px-4 py-3 font-medium">时长</th>
              <th className="px-4 py-3 font-medium">答题</th>
              <th className="px-4 py-3 font-medium">正确数</th>
              <th className="px-4 py-3 font-medium">正确率</th>
            </tr>
          </thead>
          <tbody>
            {data && data.items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center" style={{ color: 'var(--text-secondary)' }}>
                  暂无数据
                </td>
              </tr>
            )}
            {data?.items.map((m) => (
              <tr key={m.module} className="border-b border-gray-200 last:border-b-0" data-testid={`module-row-${m.module}`}>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{eventLabel(m.module)}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{m.students}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{fmtDuration(m.seconds)}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{m.answered}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{m.correct}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{fmtPct(m.accuracy)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AnalyticsPageShell>
  );
}
