import { useEffect, useState } from 'react';
import { getAdminModules, getAdminApiUsage, type ModulesData, type ApiUsageData } from '@/services/api';
import { toast } from '@/components/base';
import { AnalyticsPageShell, useAdminAnalyticsWindow, fmtPct, fmtDuration, eventLabel, apiModuleLabel } from './shared';

/**
 * 埋点 Phase 2 · 模块分析（delta spec §7 Task 15；LLM 归因 M6 扩展，设计 §3.2）。
 * 上表每模块一行：人数 / 时长 / 答题 / 正确数 / 正确率 + LLM 调用 / 输入 token / 输出 token；
 * 下表「各模块 API 调用」：api_request_logs 按 API 段聚合（calls/失败率/平均耗时）。
 * 空数组 → 「暂无数据」行（禁反向误读文案）；LLM 三列 0 是真实 0，照常显示。
 */
export default function AnalyticsModulesPage() {
  const w = useAdminAnalyticsWindow();
  const [data, setData] = useState<ModulesData | null>(null);
  const [apiUsage, setApiUsage] = useState<ApiUsageData | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getAdminModules({ from: w.from, to: w.to }),
      getAdminApiUsage({ from: w.from, to: w.to }),
    ])
      .then(([d, u]) => {
        if (!cancelled) {
          setData(d);
          setApiUsage(u);
        }
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
              <th className="px-4 py-3 font-medium">LLM 调用</th>
              <th className="px-4 py-3 font-medium">输入 token</th>
              <th className="px-4 py-3 font-medium">输出 token</th>
            </tr>
          </thead>
          <tbody>
            {data && data.items.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-6 text-center" style={{ color: 'var(--text-secondary)' }}>
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
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{m.llmCalls}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{m.llmInputTokens}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{m.llmOutputTokens}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm" data-testid="api-usage-table">
          <thead>
            <tr className="border-b border-gray-200 text-left" style={{ color: 'var(--text-secondary)' }}>
              <th className="px-4 py-3 font-medium">模块</th>
              <th className="px-4 py-3 font-medium">调用次数</th>
              <th className="px-4 py-3 font-medium">失败率</th>
              <th className="px-4 py-3 font-medium">平均耗时</th>
            </tr>
          </thead>
          <tbody>
            {apiUsage && apiUsage.items.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center" style={{ color: 'var(--text-secondary)' }}>
                  暂无数据
                </td>
              </tr>
            )}
            {apiUsage?.items.map((r) => (
              <tr
                key={r.module ?? 'null'}
                className="border-b border-gray-200 last:border-b-0"
                data-testid={`api-usage-row-${r.module ?? 'null'}`}
              >
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{apiModuleLabel(r.module)}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{r.calls}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{fmtPct(r.failureRate)}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>
                  {r.avgLatencyMs == null ? '—' : `${Math.round(r.avgLatencyMs)} ms`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AnalyticsPageShell>
  );
}
