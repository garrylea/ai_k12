import { useEffect, useState } from 'react';
import { getAdminLlmTokens, type LlmTokensData } from '@/services/api';
import { toast } from '@/components/base';
import { AnalyticsPageShell, useAdminAnalyticsWindow } from './shared';

const GROUPS: { key: string; label: string }[] = [
  { key: 'scene', label: '场景' },
  { key: 'model', label: '模型' },
  { key: 'day', label: '日期' },
  { key: 'student', label: '学生' },
];

/**
 * 埋点 Phase 2 · LLM Token 用量（delta spec §7 Task 16）。
 * groupBy 下拉 + 顶层三行汇总 + 分组明细表。
 * unavailableCalls（用量缺失）= 量不到 input/output tokens 的调用数，单列列出、
 * 不计入 0 求和（input/output_tokens 可为 NULL，NULL = 量不到，与报表「缺口」口径一致）。
 */
export default function AnalyticsLlmTokensPage() {
  const w = useAdminAnalyticsWindow();
  const [groupBy, setGroupBy] = useState<string>('scene');
  const [data, setData] = useState<LlmTokensData | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAdminLlmTokens({ from: w.from, to: w.to, groupBy })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => toast('error', e instanceof Error ? e.message : '加载失败'));
    return () => {
      cancelled = true;
    };
  }, [w.from, w.to, groupBy]);

  const summary: { label: string; value: number | null; note?: string }[] = [
    { label: '归因调用', value: data ? data.attributed : null },
    { label: '未归因调用', value: data ? data.unattributed : null },
    { label: '用量缺失调用', value: data ? data.unavailableCalls : null, note: '用量缺失不计入 0 求和' },
  ];

  return (
    <AnalyticsPageShell
      title="LLM Token 用量"
      description="模型调用了多少、哪些量不到"
      window={w}
      onWindowChange={(next) => {
        w.setFrom(next.from);
        w.setTo(next.to);
      }}
    >
      <div>
        <select
          aria-label="分组维度"
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value)}
          className="bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm"
          style={{ color: 'var(--text-primary)' }}
        >
          {GROUPS.map((g) => (
            <option key={g.key} value={g.key}>{g.label}</option>
          ))}
        </select>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 p-4 space-y-1" data-testid="tokens-summary">
        {summary.map((s) => (
          <p key={s.label} className="text-sm flex items-center gap-2" data-testid={`summary-${s.label}`}>
            <span style={{ color: 'var(--text-secondary)' }}>{s.label}</span>
            <span className="font-bold" style={{ color: 'var(--text-primary)' }}>
              {s.value == null ? '…' : s.value}
            </span>
            {s.note && <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>（{s.note}）</span>}
          </p>
        ))}
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm" data-testid="tokens-table">
          <thead>
            <tr className="border-b border-gray-200 text-left" style={{ color: 'var(--text-secondary)' }}>
              <th className="px-4 py-3 font-medium">分组项</th>
              <th className="px-4 py-3 font-medium">调用数</th>
              <th className="px-4 py-3 font-medium">输入 tokens</th>
              <th className="px-4 py-3 font-medium">输出 tokens</th>
              <th className="px-4 py-3 font-medium">用量缺失</th>
            </tr>
          </thead>
          <tbody>
            {data && data.items.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center" style={{ color: 'var(--text-secondary)' }}>
                  暂无数据
                </td>
              </tr>
            )}
            {data?.items.map((it) => (
              <tr key={it.key} className="border-b border-gray-200 last:border-b-0" data-testid={`token-row-${it.key}`}>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{it.key}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{it.calls}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{it.inputTokens}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{it.outputTokens}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{it.unavailableCalls}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AnalyticsPageShell>
  );
}
