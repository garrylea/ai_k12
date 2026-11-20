import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  listResearchAudit,
  type ResearchAuditListResult,
} from '@/services/api';
import { Pagination, Skeleton } from '@/components/base';

const PAGE_SIZE = 20;

type ActionValue = 'paper.delete' | 'question.update' | 'image.delete';
type TargetTypeValue = 'paper' | 'question' | 'image';

const ACTION_OPTIONS: Array<{ value: ActionValue | ''; label: string }> = [
  { value: '', label: '全部动作' },
  { value: 'paper.delete', label: '删除试卷' },
  { value: 'question.update', label: '更正题目' },
  { value: 'image.delete', label: '删除图片' },
];

const TARGET_TYPE_OPTIONS: Array<{ value: TargetTypeValue | ''; label: string }> = [
  { value: '', label: '全部对象' },
  { value: 'paper', label: '试卷' },
  { value: 'question', label: '题目' },
  { value: 'image', label: '图片' },
];

interface FilterDraft {
  action: ActionValue | '';
  targetType: TargetTypeValue | '';
  actorId: string;
  from: string;
  to: string;
}

const EMPTY_DRAFT: FilterDraft = { action: '', targetType: '', actorId: '', from: '', to: '' };

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : '加载失败';
}

function formatTime(iso: string): string {
  return iso.replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

/** 教研「审计日志」：按动作/对象/操作人/时间筛选，查看每次内容变更的前后快照。 */
export default function ResearchAuditPage() {
  const [draft, setDraft] = useState<FilterDraft>(EMPTY_DRAFT);
  const [applied, setApplied] = useState<FilterDraft>(EMPTY_DRAFT);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ResearchAuditListResult | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setError('');
    const params: Parameters<typeof listResearchAudit>[0] = { page, pageSize: PAGE_SIZE };
    if (applied.action) params.action = applied.action;
    if (applied.targetType) params.targetType = applied.targetType;
    if (applied.actorId) params.actorId = Number(applied.actorId);
    if (applied.from) params.from = applied.from;
    if (applied.to) params.to = applied.to;
    listResearchAudit(params)
      .then((res) => setData(res))
      .catch((err: unknown) => {
        setData(null);
        setError(errMessage(err));
      });
  }, [applied, page]);

  useEffect(() => {
    load();
  }, [load]);

  const submitFilters = (e: FormEvent) => {
    e.preventDefault();
    setPage(1);
    setApplied(draft);
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-black tracking-tight" style={{ color: 'var(--text-primary)' }}>审计日志</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          记录内容更正操作。可按动作、对象、操作人和时间检索。
        </p>
      </div>

      <form
        data-testid="audit-filter-form"
        onSubmit={submitFilters}
        className="bg-white rounded-2xl border border-gray-200 p-4 flex flex-wrap items-end gap-3"
      >
        <label className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          动作
          <select
            data-testid="audit-filter-action"
            value={draft.action}
            onChange={(e) => setDraft({ ...draft, action: e.target.value as ActionValue | '' })}
            className="block mt-1 px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white"
          >
            {ACTION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>

        <label className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          对象
          <select
            data-testid="audit-filter-target-type"
            value={draft.targetType}
            onChange={(e) => setDraft({ ...draft, targetType: e.target.value as TargetTypeValue | '' })}
            className="block mt-1 px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white"
          >
            {TARGET_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>

        <label className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          操作人 ID
          <input
            data-testid="audit-filter-actor"
            type="number"
            value={draft.actorId}
            onChange={(e) => setDraft({ ...draft, actorId: e.target.value.replace(/\D/g, '') })}
            placeholder="如 7"
            className="block mt-1 w-28 px-3 py-2 rounded-lg border border-gray-200 text-sm"
          />
        </label>

        <label className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          开始日期
          <input
            data-testid="audit-filter-from"
            type="date"
            value={draft.from}
            onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            className="block mt-1 px-3 py-2 rounded-lg border border-gray-200 text-sm"
          />
        </label>

        <label className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          结束日期
          <input
            data-testid="audit-filter-to"
            type="date"
            value={draft.to}
            onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            className="block mt-1 px-3 py-2 rounded-lg border border-gray-200 text-sm"
          />
        </label>

        <button
          type="submit"
          className="px-4 py-2 rounded-lg text-sm font-semibold bg-[var(--brand-500)] text-white hover:opacity-90"
        >
          查询
        </button>
      </form>

      {error ? (
        <div data-testid="audit-error" className="bg-white rounded-2xl border border-dashed border-gray-200 p-10 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
          审计日志加载失败，请稍后重试
        </div>
      ) : data === null ? (
        <div data-testid="audit-loading" className="bg-white rounded-2xl border border-gray-200 p-5 space-y-3">
          <Skeleton width={180} height={16} />
          <Skeleton width="80%" height={14} />
          <Skeleton width="60%" height={14} />
        </div>
      ) : data.items.length === 0 ? (
        <div data-testid="audit-empty" className="bg-white rounded-2xl border border-dashed border-gray-200 p-10 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
          没有匹配的审计记录
        </div>
      ) : (
        <div data-testid="audit-table" className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50" style={{ color: 'var(--text-secondary)' }}>
              <tr>
                <th className="text-left px-4 py-3 font-medium">时间</th>
                <th className="text-left px-4 py-3 font-medium">操作人</th>
                <th className="text-left px-4 py-3 font-medium">动作</th>
                <th className="text-left px-4 py-3 font-medium">对象</th>
                <th className="text-left px-4 py-3 font-medium">改前</th>
                <th className="text-left px-4 py-3 font-medium">改后</th>
                <th className="text-left px-4 py-3 font-medium">备注</th>
              </tr>
            </thead>
            <tbody style={{ color: 'var(--text-primary)' }}>
              {data.items.map((row) => (
                <tr key={row.id} className="border-t border-gray-100 align-top">
                  <td className="px-4 py-3 whitespace-nowrap">{formatTime(row.createdAt)}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{row.actorName ?? '—'}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{row.action}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{`${row.targetType} #${row.targetId}`}</td>
                  <td className="px-4 py-3">
                    <pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(row.beforeJson, null, 2)}</pre>
                  </td>
                  <td className="px-4 py-3">
                    <pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(row.afterJson, null, 2)}</pre>
                  </td>
                  <td className="px-4 py-3">{row.note ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.total > 0 && (
        <div className="flex items-center justify-between text-sm" style={{ color: 'var(--text-secondary)' }}>
          <span>{`共 ${data.total} 条`}</span>
          <Pagination page={page} totalPages={totalPages} onChange={setPage} />
        </div>
      )}
    </div>
  );
}
