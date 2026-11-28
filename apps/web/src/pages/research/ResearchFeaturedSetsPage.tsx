import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import { ConfirmDialog, toast } from '@/components/base';
import {
  markdownComponents,
  markdownRehypePlugins,
  markdownRemarkPlugins,
  preprocessMarkdown,
} from '@/components/markdown';
import {
  getResearchFeaturedSet,
  listResearchFeaturedSets,
  publishFeaturedSet,
  rejectFeaturedSet,
  reopenFeaturedSet,
  withdrawFeaturedPublication,
  type ResearchFeaturedSetDetail,
  type ResearchFeaturedSetItem,
} from '@/services/api';

/** 与服务端 `apps/server/src/common/utils/grade.ts` 的 GRADE_LIST 对齐（前端只读展示用）。 */
const GRADE_LIST = [
  { code: 'grade_1', label: '小学一年级' },
  { code: 'grade_2', label: '小学二年级' },
  { code: 'grade_3', label: '小学三年级' },
  { code: 'grade_4', label: '小学四年级' },
  { code: 'grade_5', label: '小学五年级' },
  { code: 'grade_6', label: '小学六年级' },
  { code: 'grade_7', label: '初一' },
  { code: 'grade_8', label: '初二' },
  { code: 'grade_9', label: '初三' },
  { code: 'grade_10', label: '高一' },
  { code: 'grade_11', label: '高二' },
  { code: 'grade_12', label: '高三' },
] as const;

const gradeLabel = (code: string): string =>
  GRADE_LIST.find((g) => g.code === code)?.label ?? code;

/** 审核操作成功后通知侧栏角标重拉（ResearchNav 同时监听 mount / focus / 本事件）。 */
export const FEATURED_SETS_CHANGED = 'featured-sets-changed';
const notifyChanged = () => window.dispatchEvent(new Event(FEATURED_SETS_CHANGED));

type TabKey = 'pending' | 'approved' | 'rejected';

const TABS = [
  { key: 'pending', label: '待审核' },
  { key: 'approved', label: '已发布' },
  { key: 'rejected', label: '已拒绝' },
] as const;

const PAGE_SIZE = 20;
const TITLE_MAX = 60;

type ListResult = Awaited<ReturnType<typeof listResearchFeaturedSets>>;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : '操作失败';
}

function formatCreatedAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false });
}

function formatDistribution(dist: ResearchFeaturedSetItem['gradeDistribution']): string {
  return dist.map((g) => `${gradeLabel(g.gradeCode)} ${g.count}`).join(' · ');
}

/**
 * 教研「精选题单」审核工作台：三个固定 Tab（待审核 / 已发布 / 已拒绝）。
 *
 * - 列表展示推荐人数与年级分布，点行开详情抽屉；题目正文复用共享 Markdown 配置。
 * - 发布 / 拒绝 / 重新审核 / 撤回四类写操作用一个 ref 闸门防连点（ConfirmDialog 的
 *   确认按钮本身不可 disabled，只能靠 ref 同步拦截）。
 * - 审核动作成功后 dispatch `featured-sets-changed`，让 ResearchNav 的 pending 角标
 *   立刻重拉（角标不在本页内，靠事件跨组件同步）。
 */
export default function ResearchFeaturedSetsPage() {
  const [tab, setTab] = useState<TabKey>('pending');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResult | null>(null);
  const [listError, setListError] = useState('');

  const [detailSetId, setDetailSetId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ResearchFeaturedSetDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  // 快速切换行时，旧 setId 的详情响应可能晚到；只接受最新一次请求的回填
  const detailRequestRef = useRef<number | null>(null);

  const [publishTarget, setPublishTarget] = useState<number | null>(null);
  const [publishTitle, setPublishTitle] = useState('');
  const [publishGrade, setPublishGrade] = useState<string>('grade_7');
  const [publishError, setPublishError] = useState('');

  const [rejectTarget, setRejectTarget] = useState<number | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setListError('');
    listResearchFeaturedSets(tab, page)
      .then((res) => setData(res))
      .catch((err: unknown) => {
        setData(null);
        setListError(errMessage(err));
        toast('error', errMessage(err));
      });
  }, [tab, page]);

  useEffect(() => {
    load();
  }, [load]);

  const refreshAll = useCallback(() => {
    load();
    notifyChanged();
  }, [load]);

  const loadDetail = useCallback((setId: number) => {
    detailRequestRef.current = setId;
    setDetailLoading(true);
    setDetailError('');
    getResearchFeaturedSet(setId)
      .then((res) => {
        if (detailRequestRef.current !== setId) return;
        setDetail(res);
      })
      .catch((err: unknown) => {
        if (detailRequestRef.current !== setId) return;
        setDetail(null);
        setDetailError(errMessage(err));
        toast('error', errMessage(err));
      })
      .finally(() => {
        if (detailRequestRef.current === setId) setDetailLoading(false);
      });
  }, []);

  const handleTab = (key: TabKey) => {
    if (busyRef.current || key === tab) return;
    setTab(key);
    setPage(1);
    detailRequestRef.current = null;
    setDetailSetId(null);
    setDetail(null);
  };

  const openDetail = (setId: number) => {
    if (busyRef.current) return;
    setDetailSetId(setId);
    setDetail(null);
    loadDetail(setId);
  };

  const closeDetail = () => {
    if (busyRef.current) return;
    detailRequestRef.current = null;
    setDetailSetId(null);
    setDetail(null);
  };

  const openPublish = (setId: number) => {
    if (busyRef.current) return;
    setPublishTarget(setId);
    setPublishTitle('');
    setPublishGrade('grade_7');
    setPublishError('');
  };

  const closePublish = () => {
    if (busyRef.current) return;
    setPublishTarget(null);
    setPublishError('');
  };

  const submitPublish = (e: FormEvent) => {
    e.preventDefault();
    if (busyRef.current || publishTarget === null) return;
    const title = publishTitle.trim();
    if (!title || title.length > TITLE_MAX) {
      setPublishError(`标题需 1～${TITLE_MAX} 字`);
      return;
    }
    const setId = publishTarget;
    busyRef.current = true;
    setBusy(true);
    publishFeaturedSet(setId, { title, gradeCode: publishGrade })
      .then(() => {
        setPublishTarget(null);
        setPublishError('');
        refreshAll();
      })
      .catch((err: unknown) => toast('error', errMessage(err)))
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  };

  const confirmReject = () => {
    if (busyRef.current || rejectTarget === null) return;
    const setId = rejectTarget;
    busyRef.current = true;
    setBusy(true);
    rejectFeaturedSet(setId)
      .then(() => {
        setRejectTarget(null);
        setDetailSetId(null);
        refreshAll();
      })
      .catch((err: unknown) => toast('error', errMessage(err)))
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  };

  const handleReopen = (setId: number) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    reopenFeaturedSet(setId)
      .then(refreshAll)
      .catch((err: unknown) => toast('error', errMessage(err)))
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  };

  const handleWithdraw = (publicationId: number) => {
    if (busyRef.current || detailSetId === null) return;
    const setId = detailSetId;
    busyRef.current = true;
    setBusy(true);
    withdrawFeaturedPublication(publicationId)
      .then(() => {
        loadDetail(setId);
        refreshAll();
      })
      .catch((err: unknown) => toast('error', errMessage(err)))
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  };

  const onRowKeyDown = (e: KeyboardEvent<HTMLDivElement>, setId: number) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openDetail(setId);
    }
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const rejectRow = data?.items.find((row) => row.setId === rejectTarget);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-black tracking-tight" style={{ color: 'var(--text-primary)' }}>
        精选题单
      </h1>

      <div role="tablist" className="flex gap-2 border-b border-gray-200">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            data-testid={`featured-tab-${t.key}`}
            aria-selected={tab === t.key}
            onClick={() => handleTab(t.key)}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors ${
              tab === t.key
                ? 'border-[var(--brand-500)] text-[var(--brand-600)]'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {listError ? (
        <div
          data-testid="featured-error"
          className="bg-white rounded-2xl border border-dashed border-gray-200 p-10 text-center text-sm"
          style={{ color: 'var(--text-secondary)' }}
        >
          {listError}
        </div>
      ) : data === null ? (
        <div data-testid="featured-loading" className="bg-white rounded-2xl border border-gray-200 p-10 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
          加载中…
        </div>
      ) : data.items.length === 0 ? (
        <div data-testid="featured-empty" className="bg-white rounded-2xl border border-dashed border-gray-200 p-10 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
          暂无题单
        </div>
      ) : (
        <div data-testid="featured-list" className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          {data.items.map((row) => (
            <div
              key={row.setId}
              data-testid={`featured-set-row-${row.setId}`}
              role="button"
              tabIndex={0}
              onClick={() => openDetail(row.setId)}
              onKeyDown={(e) => onRowKeyDown(e, row.setId)}
              className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 border-b border-gray-100 last:border-b-0 cursor-pointer hover:bg-gray-50 text-sm"
              style={{ color: 'var(--text-primary)' }}
            >
              <div className="flex items-center gap-3 min-w-[140px]">
                <span className="font-semibold">{row.subjectName}</span>
                <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {formatCreatedAt(row.createdAt)}
                </span>
              </div>
              <div className="flex items-center gap-4" style={{ color: 'var(--text-secondary)' }}>
                <span>{row.questionCount} 题</span>
                <span>{row.recommendationCount} 人推荐</span>
                <span>{formatDistribution(row.gradeDistribution)}</span>
              </div>
              <div className="ml-auto flex gap-2" onClick={(e) => e.stopPropagation()}>
                {row.reviewStatus === 'pending' && (
                  <>
                    <button
                      type="button"
                      data-testid={`featured-publish-${row.setId}`}
                      disabled={busy}
                      onClick={() => openPublish(row.setId)}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[var(--brand-500)] text-white hover:opacity-90 disabled:opacity-40"
                    >
                      发布
                    </button>
                    <button
                      type="button"
                      data-testid={`featured-reject-${row.setId}`}
                      disabled={busy}
                      onClick={() => setRejectTarget(row.setId)}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold text-[var(--error)] border border-[var(--error)]/40 hover:bg-[var(--error)]/5 disabled:opacity-40"
                    >
                      拒绝
                    </button>
                  </>
                )}
                {row.reviewStatus === 'rejected' && (
                  <button
                    type="button"
                    data-testid={`featured-reopen-${row.setId}`}
                    disabled={busy}
                    onClick={() => handleReopen(row.setId)}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold text-[var(--brand-600)] border border-[var(--brand-500)]/40 hover:bg-[var(--brand-100)] disabled:opacity-40"
                  >
                    重新审核
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {data && data.total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm" style={{ color: 'var(--text-secondary)' }}>
          <span>{`共 ${data.total} 条`}</span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="px-3 py-1.5 rounded-lg border border-gray-200 disabled:opacity-40"
            >
              上一页
            </button>
            <span className="px-2 py-1.5">{`${page} / ${totalPages}`}</span>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="px-3 py-1.5 rounded-lg border border-gray-200 disabled:opacity-40"
            >
              下一页
            </button>
          </div>
        </div>
      )}

      {/* 详情抽屉 */}
      {detailSetId !== null && (
        <div
          className="fixed inset-0 z-40 flex justify-end bg-black/40"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeDetail();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="题单详情"
            className="w-full max-w-xl h-full overflow-y-auto bg-[var(--bg-elevated)] shadow-xl p-6 space-y-6"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>题单详情</h2>
              <button
                type="button"
                aria-label="关闭"
                onClick={closeDetail}
                className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:bg-gray-100"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="w-4 h-4" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {detailLoading ? (
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>加载中…</p>
            ) : detailError ? (
              <p className="text-sm" style={{ color: 'var(--error)' }}>{detailError}</p>
            ) : detail && (
              <>
                <section className="space-y-4">
                  <h3 className="text-sm font-bold" style={{ color: 'var(--text-secondary)' }}>题目</h3>
                  {detail.questions.map((q, i) => (
                    <div key={q.questionId} className="rounded-xl border border-gray-200 p-4 space-y-2 text-sm">
                      <div className="font-semibold">{`第 ${i + 1} 题`}</div>
                      <div className="leading-[1.7]" style={{ color: 'var(--text-primary)' }}>
                        <ReactMarkdown
                          remarkPlugins={markdownRemarkPlugins}
                          rehypePlugins={markdownRehypePlugins}
                          components={markdownComponents}
                        >
                          {preprocessMarkdown(q.text)}
                        </ReactMarkdown>
                      </div>
                      <div style={{ color: 'var(--text-secondary)' }}>{`答案：${q.answer}`}</div>
                      {q.explanation && (
                        <div style={{ color: 'var(--text-secondary)' }}>{q.explanation}</div>
                      )}
                    </div>
                  ))}
                </section>

                <section className="space-y-3">
                  <h3 className="text-sm font-bold" style={{ color: 'var(--text-secondary)' }}>发布记录</h3>
                  {detail.publications.length === 0 ? (
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>暂无发布记录</p>
                  ) : (
                    detail.publications.map((pub) => (
                      <div key={pub.publicationId} className="flex items-center gap-3 rounded-xl border border-gray-200 p-4 text-sm">
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="font-semibold truncate">{pub.title}</div>
                          <div style={{ color: 'var(--text-secondary)' }}>
                            {`${gradeLabel(pub.gradeCode)} · 触达 ${pub.reachCount} 人 · ${pub.status === 'published' ? '已发布' : '已撤回'}`}
                          </div>
                        </div>
                        {pub.status === 'published' && (
                          <button
                            type="button"
                            data-testid={`featured-withdraw-${pub.publicationId}`}
                            disabled={busy}
                            onClick={() => handleWithdraw(pub.publicationId)}
                            className="px-3 py-1.5 rounded-lg text-xs font-semibold text-[var(--error)] border border-[var(--error)]/40 hover:bg-[var(--error)]/5 disabled:opacity-40"
                          >
                            撤回
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </section>
              </>
            )}
          </div>
        </div>
      )}

      {/* 发布弹窗 */}
      {publishTarget !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={(e) => {
            if (e.target === e.currentTarget) closePublish();
          }}
        >
          <div role="dialog" aria-modal="true" aria-label="发布精选题单" className="w-[92vw] max-w-md bg-[var(--bg-elevated)] rounded-2xl p-6 shadow-xl">
            <h2 className="text-xl font-bold mb-4" style={{ color: 'var(--text-primary)' }}>发布精选题单</h2>
            <form onSubmit={submitPublish} className="space-y-4">
              <label className="block text-sm" style={{ color: 'var(--text-secondary)' }}>
                标题
                <input
                  data-testid="publish-title-input"
                  value={publishTitle}
                  onChange={(e) => setPublishTitle(e.target.value)}
                  maxLength={TITLE_MAX + 20}
                  placeholder="1～60 字"
                  className="block mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 text-sm"
                  style={{ color: 'var(--text-primary)' }}
                />
              </label>
              <label className="block text-sm" style={{ color: 'var(--text-secondary)' }}>
                年级
                <select
                  data-testid="publish-grade-select"
                  value={publishGrade}
                  onChange={(e) => setPublishGrade(e.target.value)}
                  className="block mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white"
                >
                  {GRADE_LIST.map((g) => (
                    <option key={g.code} value={g.code}>{g.label}</option>
                  ))}
                </select>
              </label>
              {publishError && (
                <p data-testid="publish-error" className="text-sm" style={{ color: 'var(--error)' }}>{publishError}</p>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={closePublish}
                  className="px-4 py-2 rounded-lg text-sm border border-gray-200 hover:bg-gray-50"
                >
                  取消
                </button>
                <button
                  type="submit"
                  data-testid="publish-submit"
                  disabled={busy}
                  className="px-4 py-2 rounded-lg text-sm font-semibold bg-[var(--brand-500)] text-white hover:opacity-90 disabled:opacity-40"
                >
                  发布
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 拒绝确认 */}
      <ConfirmDialog
        open={rejectTarget !== null}
        title="提示："
        message={rejectRow ? `确认拒绝《${rejectRow.subjectName}》题单（${rejectRow.questionCount} 题）？` : ''}
        onConfirm={confirmReject}
        onCancel={() => {
          if (!busyRef.current) setRejectTarget(null);
        }}
      />
    </div>
  );
}
