import { useEffect, useState } from 'react';
import { getAdminEvents, type Paged } from '@/services/api';
import { toast } from '@/components/base';
import { AnalyticsPageShell, useAdminAnalyticsWindow, eventLabel } from './shared';

type EventRow = Record<string, unknown>;

const s = (v: unknown): string => (v == null ? '—' : String(v));

/** 服务端 created_at 经 JSON 序列化为 ISO；展示成 'YYYY-MM-DD HH:MM:SS'（截去毫秒/时区）。 */
const fmtTime = (v: unknown): string => (v == null ? '—' : String(v).replace('T', ' ').slice(0, 19));

const refText = (r: EventRow): string => {
  if (r.ref_id == null) return '—';
  return r.ref_type != null ? `${r.ref_type}:${r.ref_id}` : String(r.ref_id);
};

const PAGE_SIZE_FALLBACK = 20;

/**
 * 埋点 Phase 2 · 事件流（delta spec §7 Task 16）。
 * behavior_events 原始行（蛇形列名，无 DTO 映射）+ event/module 两个筛选输入 + 分页。
 * 筛选与日期窗变化都回第 1 页（沿用「换条件必须回第 1 页」的既成约定）。
 */
export default function AnalyticsEventsPage() {
  const w = useAdminAnalyticsWindow();
  const [event, setEvent] = useState('');
  const [module, setModule] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paged<EventRow> | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAdminEvents({
      from: w.from,
      to: w.to,
      page,
      event: event || undefined,
      module: module || undefined,
    })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => toast('error', e instanceof Error ? e.message : '加载失败'));
    return () => {
      cancelled = true;
    };
  }, [w.from, w.to, event, module, page]);

  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? PAGE_SIZE_FALLBACK;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <AnalyticsPageShell
      title="事件流"
      description="原始埋点事件明细，按时间倒序"
      window={w}
      onWindowChange={(next) => {
        w.setFrom(next.from);
        w.setTo(next.to);
        setPage(1);
      }}
    >
      <div className="flex items-center gap-2">
        <input
          type="text"
          aria-label="事件筛选"
          placeholder="事件名，如 answer_submitted"
          value={event}
          onChange={(e) => {
            setEvent(e.target.value);
            setPage(1);
          }}
          className="bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm"
          style={{ color: 'var(--text-primary)' }}
        />
        <input
          type="text"
          aria-label="模块筛选"
          placeholder="模块名，如 mainline"
          value={module}
          onChange={(e) => {
            setModule(e.target.value);
            setPage(1);
          }}
          className="bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm"
          style={{ color: 'var(--text-primary)' }}
        />
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm" data-testid="events-table">
          <thead>
            <tr className="border-b border-gray-200 text-left" style={{ color: 'var(--text-secondary)' }}>
              <th className="px-4 py-3 font-medium">时间</th>
              <th className="px-4 py-3 font-medium">事件</th>
              <th className="px-4 py-3 font-medium">层级</th>
              <th className="px-4 py-3 font-medium">模块</th>
              <th className="px-4 py-3 font-medium">场景</th>
              <th className="px-4 py-3 font-medium">学生 ID</th>
              <th className="px-4 py-3 font-medium">引用</th>
            </tr>
          </thead>
          <tbody>
            {data && data.items.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center" style={{ color: 'var(--text-secondary)' }}>
                  暂无数据
                </td>
              </tr>
            )}
            {data?.items.map((r, i) => (
              <tr key={r.id != null ? String(r.id) : i} className="border-b border-gray-200 last:border-b-0" data-testid={`event-row-${r.id ?? i}`}>
                <td className="px-4 py-3 whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{fmtTime(r.created_at)}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{eventLabel(s(r.event))}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{s(r.tier)}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{r.module == null ? '—' : eventLabel(String(r.module))}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{s(r.scene)}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{s(r.student_id)}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{refText(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3" data-testid="events-pagination">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
          className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm disabled:opacity-40"
          style={{ color: 'var(--text-primary)' }}
        >
          上一页
        </button>
        <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          第 {page} / {totalPages} 页 · 共 {total} 条
        </span>
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => setPage((p) => p + 1)}
          className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm disabled:opacity-40"
          style={{ color: 'var(--text-primary)' }}
        >
          下一页
        </button>
      </div>
    </AnalyticsPageShell>
  );
}
