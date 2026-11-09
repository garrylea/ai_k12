import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  deleteAdminPaper,
  getAdminPaperDeletePreview,
  listAdminPapers,
  type AdminPaperDeletePreview,
  type AdminPaperListResult,
} from '@/services/api';
import { ConfirmDialog, Skeleton, toast } from '@/components/base';
import { TRAINING_SUBJECTS } from '@/subjectConfig';

const PAGE_SIZE = 20;

const GRADE_OPTIONS = [
  { value: '', label: '全部年级' },
  { value: 'primary', label: '小学' },
  { value: 'junior', label: '初中' },
  { value: 'senior', label: '高中' },
];

interface FilterDraft {
  subjectId: string;
  gradeBand: string;
  year: string;
  keyword: string;
}

const EMPTY_DRAFT: FilterDraft = { subjectId: '', gradeBand: '', year: '', keyword: '' };

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : '操作失败';
}

/**
 * 管理端「试卷管理」：筛选 + 删除套卷。
 *
 * 删除前必须先调 delete-preview 展示真实影响面（题数/共享/保留/会话/作答）；
 * 确认删除不可恢复。防连点用 ref 闸门（ConfirmDialog 的确认按钮没有 disabled，
 * state 要等下一次渲染才生效——同 AdminAlertsPage 的 purgingRef）。
 */
export default function AdminPapersPage() {
  const [draft, setDraft] = useState<FilterDraft>(EMPTY_DRAFT);
  const [applied, setApplied] = useState<FilterDraft>(EMPTY_DRAFT);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AdminPaperListResult | null>(null);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<AdminPaperDeletePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);

  const load = useCallback(() => {
    setError('');
    const params: Parameters<typeof listAdminPapers>[0] = { page, pageSize: PAGE_SIZE };
    if (applied.subjectId) params.subjectId = Number(applied.subjectId);
    if (applied.gradeBand) params.gradeBand = applied.gradeBand;
    if (applied.year) params.year = Number(applied.year);
    if (applied.keyword.trim()) params.keyword = applied.keyword.trim();
    listAdminPapers(params)
      .then((res) => setData(res))
      .catch((err: unknown) => {
        setData(null);
        setError(errMessage(err));
        toast('error', errMessage(err));
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

  const handleDeleteClick = async (paperId: number) => {
    if (previewing) return;
    setPreviewing(true);
    try {
      setPreview(await getAdminPaperDeletePreview(paperId));
    } catch (err) {
      toast('error', errMessage(err));
    } finally {
      setPreviewing(false);
    }
  };

  const handleConfirm = async () => {
    if (!preview || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    try {
      const res = await deleteAdminPaper(preview.paperId);
      toast('success', `已删除《${preview.title}》：题目 ${res.deletedQuestions} 道、会话 ${res.deletedSessions} 场`);
      setPreview(null);
      if (page > 1 && data?.items.length === 1) {
        setPage(page - 1);
      } else {
        load();
      }
    } catch (err) {
      toast('error', errMessage(err));
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-black tracking-tight" style={{ color: 'var(--text-primary)' }}>试卷管理</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          删除导错的套卷。只删该卷独占的题；共享题仅解除关联；删除不可恢复。
        </p>
      </div>

      <form
        data-testid="papers-filter-form"
        onSubmit={submitFilters}
        className="bg-white rounded-2xl border border-gray-200 p-4 flex flex-wrap items-end gap-3"
      >
        <label className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          学科
          <select
            data-testid="papers-filter-subject"
            value={draft.subjectId}
            onChange={(e) => setDraft({ ...draft, subjectId: e.target.value })}
            className="block mt-1 px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white"
          >
            <option value="">全部学科</option>
            {TRAINING_SUBJECTS.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>

        <label className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          年级
          <select
            data-testid="papers-filter-grade"
            value={draft.gradeBand}
            onChange={(e) => setDraft({ ...draft, gradeBand: e.target.value })}
            className="block mt-1 px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white"
          >
            {GRADE_OPTIONS.map((g) => (
              <option key={g.value} value={g.value}>{g.label}</option>
            ))}
          </select>
        </label>

        <label className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          年份
          <input
            data-testid="papers-filter-year"
            value={draft.year}
            onChange={(e) => setDraft({ ...draft, year: e.target.value.replace(/\D/g, '').slice(0, 4) })}
            placeholder="如 2026"
            className="block mt-1 w-28 px-3 py-2 rounded-lg border border-gray-200 text-sm"
          />
        </label>

        <label className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          标题关键词
          <input
            data-testid="papers-filter-keyword"
            value={draft.keyword}
            onChange={(e) => setDraft({ ...draft, keyword: e.target.value.slice(0, 50) })}
            placeholder="如 汇文"
            className="block mt-1 w-56 px-3 py-2 rounded-lg border border-gray-200 text-sm"
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
        <div data-testid="papers-error" className="bg-white rounded-2xl border border-dashed border-gray-200 p-10 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
          试卷列表加载失败，请稍后重试
        </div>
      ) : data === null ? (
        <div data-testid="papers-loading" className="bg-white rounded-2xl border border-gray-200 p-5 space-y-3">
          <Skeleton width={180} height={16} />
          <Skeleton width="80%" height={14} />
          <Skeleton width="60%" height={14} />
        </div>
      ) : data.items.length === 0 ? (
        <div data-testid="papers-empty" className="bg-white rounded-2xl border border-dashed border-gray-200 p-10 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
          没有匹配的试卷
        </div>
      ) : (
        <div data-testid="papers-table" className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50" style={{ color: 'var(--text-secondary)' }}>
              <tr>
                <th className="text-left px-4 py-3 font-medium">标题</th>
                <th className="text-left px-4 py-3 font-medium">学科</th>
                <th className="text-left px-4 py-3 font-medium">年份</th>
                <th className="text-left px-4 py-3 font-medium">年级</th>
                <th className="text-right px-4 py-3 font-medium">题数</th>
                <th className="text-right px-4 py-3 font-medium">考试人次</th>
                <th className="text-right px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody style={{ color: 'var(--text-primary)' }}>
              {data.items.map((paper) => (
                <tr key={paper.id} className="border-t border-gray-100">
                  <td className="px-4 py-3">{paper.title}</td>
                  <td className="px-4 py-3">{paper.subjectName}</td>
                  <td className="px-4 py-3">{paper.year ?? '—'}</td>
                  <td className="px-4 py-3">{paper.grade ?? '—'}</td>
                  <td className="px-4 py-3 text-right">{paper.questionCount}</td>
                  <td className="px-4 py-3 text-right">{paper.sessionCount}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      data-testid={`paper-delete-${paper.id}`}
                      disabled={previewing}
                      onClick={() => handleDeleteClick(paper.id)}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold text-[var(--error)] border border-[var(--error)]/40 hover:bg-[var(--error)]/5 disabled:opacity-40"
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.total > 0 && (
        <div className="flex items-center justify-between text-sm" style={{ color: 'var(--text-secondary)' }}>
          <span>{`共 ${data.total} 条`}</span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
              className="px-3 py-1.5 rounded-lg border border-gray-200 disabled:opacity-40"
            >
              上一页
            </button>
            <span className="px-2 py-1.5">{`${page} / ${totalPages}`}</span>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
              className="px-3 py-1.5 rounded-lg border border-gray-200 disabled:opacity-40"
            >
              下一页
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={preview !== null}
        title="提示："
        message={
          preview
            ? `确认删除试卷《${preview.title}》？\n将删除题目 ${preview.deletableCount} 道（共享题 ${preview.sharedCount} 道仅解除关联、被学生数据引用 ${preview.retainedCount} 道保留）、考试会话 ${preview.sessionCount} 场、作答 ${preview.answerCount} 条。此操作不可恢复。`
            : ''
        }
        onConfirm={handleConfirm}
        onCancel={() => {
          if (!deleting) setPreview(null);
        }}
      />
    </div>
  );
}
