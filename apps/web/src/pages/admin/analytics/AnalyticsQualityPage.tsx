import { useEffect, useState } from 'react';
import { getAdminQuality, type QualityData } from '@/services/api';
import { toast } from '@/components/base';
import { AnalyticsPageShell, useAdminAnalyticsWindow, fmtPct } from './shared';

/**
 * 埋点 Phase 2 · 质量监控（delta spec §7 Task 16）。
 * 4 张比率指标卡 + 错误码分布表 + 内容四指标行。
 * passageSkipRate 无可靠数据源恒 null（delta spec §7.2），fmtPct(null) = '—'。
 */
export default function AnalyticsQualityPage() {
  const w = useAdminAnalyticsWindow();
  const [data, setData] = useState<QualityData | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAdminQuality({ from: w.from, to: w.to })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => toast('error', e instanceof Error ? e.message : '加载失败'));
    return () => {
      cancelled = true;
    };
  }, [w.from, w.to]);

  const cards = [
    { label: 'API 失败率', value: data ? fmtPct(data.apiFailureRate) : '…' },
    { label: 'LLM 超时率', value: data ? fmtPct(data.llmTimeoutRate) : '…' },
    { label: 'LLM 降级率', value: data ? fmtPct(data.llmFallbackRate) : '…' },
    { label: '归因覆盖率', value: data ? fmtPct(data.llmAttributionCoverage) : '…' },
  ];

  const contentMetrics = [
    { label: '知识点覆盖率', value: data ? fmtPct(data.kpCoverage.rate) : '…' },
    { label: '全局错词率', value: data ? fmtPct(data.globalWordErrorRate.rate) : '…' },
    { label: '课文跳过率', value: data ? fmtPct(data.passageSkipRate) : '…' },
    { label: '缺标准答案题数', value: data ? String(data.questionsWithoutStandardAnswer) : '…' },
  ];

  return (
    <AnalyticsPageShell
      title="质量监控"
      description="接口与模型的健康度、内容数据的缺口"
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

      <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>错误码分布</h2>
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm" data-testid="error-code-table">
          <thead>
            <tr className="border-b border-gray-200 text-left" style={{ color: 'var(--text-secondary)' }}>
              <th className="px-4 py-3 font-medium">错误码</th>
              <th className="px-4 py-3 font-medium">次数</th>
            </tr>
          </thead>
          <tbody>
            {data && data.errorCodeDistribution.length === 0 && (
              <tr>
                <td colSpan={2} className="px-4 py-6 text-center" style={{ color: 'var(--text-secondary)' }}>
                  暂无数据
                </td>
              </tr>
            )}
            {data?.errorCodeDistribution.map((e) => (
              <tr key={e.code} className="border-b border-gray-200 last:border-b-0" data-testid={`error-code-row-${e.code}`}>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{e.code}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{e.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>内容指标</h2>
      <div className="grid grid-cols-4 gap-4">
        {contentMetrics.map((c) => (
          <div key={c.label} className="bg-white rounded-2xl border border-gray-200 p-6" data-testid={`content-${c.label}`}>
            <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>{c.label}</div>
            <div className="text-2xl font-black" style={{ color: 'var(--text-primary)' }}>{c.value}</div>
          </div>
        ))}
      </div>
    </AnalyticsPageShell>
  );
}
