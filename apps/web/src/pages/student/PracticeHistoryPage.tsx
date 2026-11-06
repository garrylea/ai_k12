import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import clsx from 'clsx';
import { Card, Skeleton } from '@/components/base';
import { getPracticeHistory, type PracticeHistoryItem } from '@/services/api';
import { TRAINING_SUBJECTS } from '@/subjectConfig';

/**
 * 练习记录列表（2026-11-01）——挂在 `StudentStayLayout` 下，写死日间。
 *
 * 把「考试」与「专项练习」合并成一个视角（服务端 UNION）。同一套卷子做多次
 * = 多个 session = 多条记录（session 粒度，spec §2 决策 2）。
 * 进行中（completedAt 为空）灰显并标「进行中」，仍可点进去看已答部分。
 */

const SUBJECT_NAME = new Map<number, string>(TRAINING_SUBJECTS.map((s) => [s.id, s.name]));

function formatDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function HistoryRow({ item, state }: { item: PracticeHistoryItem; state: unknown }) {
  const inProgress = item.completedAt === null;
  return (
    <li>
      <Link
        to={`/student/practice-history/${item.source}/${item.sessionId}`}
        // 来源页协议要穿过详情页：详情页「退出本页」仍要回进入浅停留页之前的那一页
        state={state}
        className={clsx(
          'block rounded-[var(--radius-md)] border border-[var(--bg-subtle)] bg-[var(--bg-card)] p-4 transition-colors hover:border-[var(--brand-300)]',
          inProgress && 'opacity-60',
        )}
        data-testid={`history-row-${item.source}-${item.sessionId}`}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded-[var(--radius-pill)] bg-[var(--bg-subtle)] px-2 py-0.5 text-xs text-[var(--text-secondary)]">
              {SUBJECT_NAME.get(item.subjectId) ?? '学科'}
            </span>
            <span className="truncate text-base font-semibold text-[var(--text-primary)]">
              {item.title ?? (item.source === 'exam' ? '考试' : '专项练习')}
            </span>
            {inProgress && (
              <span className="shrink-0 text-xs text-[var(--text-tertiary)]">进行中</span>
            )}
          </div>
          <span className="shrink-0 text-xs text-[var(--text-tertiary)] tabular-nums">
            {formatDate(item.startedAt)}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-3 text-sm text-[var(--text-secondary)]">
          <span>
            {`共 ${item.totalCount} 题 · 对 ${item.correctCount}/${item.totalCount}`}
          </span>
          <span className="rounded-[var(--radius-pill)] bg-[var(--bg-subtle)] px-2 py-0.5 text-xs text-[var(--text-tertiary)]">
            {item.source === 'exam' ? '考试' : '专项'}
          </span>
        </div>
      </Link>
    </li>
  );
}

export default function PracticeHistoryPage() {
  const location = useLocation();
  const [items, setItems] = useState<PracticeHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [subjectId, setSubjectId] = useState<number | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 20;

  // 换学科必须回第 1 页（CLAUDE.md 铁律：否则带旧页码请求会停在空态且分页控件不渲染）。
  useEffect(() => {
    setPage(1);
  }, [subjectId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    getPracticeHistory({ page, pageSize, subjectId })
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setTotal(res.total);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [page, pageSize, subjectId]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
      <h1 className="text-2xl font-black tracking-tight text-[var(--text-primary)]">练习记录</h1>

      {/* 学科筛选 */}
      <div className="flex flex-wrap gap-2" role="group" aria-label="学科筛选">
        <button
          type="button"
          onClick={() => setSubjectId(undefined)}
          className={clsx(
            'rounded-[var(--radius-pill)] px-3 py-1 text-xs transition-colors',
            subjectId === undefined
              ? 'bg-[var(--brand-500)] text-white'
              : 'bg-[var(--bg-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
          )}
        >
          全部
        </button>
        {TRAINING_SUBJECTS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSubjectId(s.id)}
            className={clsx(
              'rounded-[var(--radius-pill)] px-3 py-1 text-xs transition-colors',
              subjectId === s.id
                ? 'bg-[var(--brand-500)] text-white'
                : 'bg-[var(--bg-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
            )}
          >
            {s.name}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-3" data-testid="history-skeleton">
          <Skeleton width="100%" height={78} rounded />
          <Skeleton width="100%" height={78} rounded />
          <Skeleton width="100%" height={78} rounded />
        </div>
      ) : failed ? (
        <Card className="p-6 text-sm text-[var(--text-secondary)]">练习记录暂时加载失败</Card>
      ) : items.length === 0 ? (
        <Card className="p-6" data-testid="history-empty">
          <p className="text-sm text-[var(--text-secondary)]">还没有练习记录</p>
          <p className="mt-1 text-xs text-[var(--text-tertiary)]">
            去训练轨做一次专项练习，或在考试里交一次卷，这里就会留下记录。
          </p>
        </Card>
      ) : (
        <>
          <ul className="space-y-3">
            {items.map((item) => (
              <HistoryRow
                key={`${item.source}-${item.sessionId}`}
                item={item}
                state={location.state}
              />
            ))}
          </ul>

          {total > pageSize && (
            <div className="flex items-center justify-center gap-3 pt-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="rounded-[var(--radius-pill)] border border-[var(--bg-subtle)] px-3 py-1 text-xs text-[var(--text-secondary)] disabled:opacity-40"
              >
                上一页
              </button>
              <span className="text-xs text-[var(--text-tertiary)] tabular-nums">
                {`${page} / ${totalPages}`}
              </span>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="rounded-[var(--radius-pill)] border border-[var(--bg-subtle)] px-3 py-1 text-xs text-[var(--text-secondary)] disabled:opacity-40"
              >
                下一页
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
