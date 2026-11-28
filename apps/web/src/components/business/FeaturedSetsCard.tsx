import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Skeleton } from '@/components/base';
import {
  getFeaturedUnreadSummary,
  listFeaturedSets,
  openFeaturedSet,
  type FeaturedSetListItem,
  type FeaturedSetPage,
  type FeaturedUnreadSummary,
} from '@/services/api';

/**
 * 个人中心「精选题单」卡片（计划 §3 Task 11）。
 *
 * 列表与未读数是**两个独立请求**：未读总数来自 unread-count 端点，翻页只重拉列表，
 * 不能拿当前页里的 isRead 行数冒充总数。开题成功后写 `training:targeted` 交接体：
 * `sessionId` 恒 null（featured 不发分）、`sessionUid` / `questions` / `title` 全用
 * 服务端 open 端点返回值，运行器不得自备 uid。
 */

const PAGE_SIZE = 20;
const HANDOFF_KEY = 'training:targeted';

/** 精选题单未读行的圆点：线性 SVG（无 emoji、无装饰图）。 */
const UnreadDot = () => (
  <svg viewBox="0 0 8 8" width="8" height="8" fill="none" aria-hidden="true">
    <circle cx="4" cy="4" r="3" fill="currentColor" />
  </svg>
);

export default function FeaturedSetsCard() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [list, setList] = useState<FeaturedSetPage | null>(null);
  const [listFailed, setListFailed] = useState(false);
  // null = 未拿到（失败静默，不显示未读徽标）
  const [unread, setUnread] = useState<FeaturedUnreadSummary | null>(null);
  const [openingId, setOpeningId] = useState<number | null>(null);
  const [openFailed, setOpenFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setList(null);
    setListFailed(false);
    listFeaturedSets(page)
      .then((res) => {
        if (!cancelled) setList(res);
      })
      .catch(() => {
        if (!cancelled) setListFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [page]);

  // 只在挂载时拉一次：翻页不改变未读总数
  useEffect(() => {
    let cancelled = false;
    getFeaturedUnreadSummary()
      .then((res) => {
        if (!cancelled) setUnread(res);
      })
      .catch(() => {
        // 徽标是锦上添花：拉不到就当没未读，不挡列表
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const open = async (item: FeaturedSetListItem) => {
    if (openingId !== null) return;
    setOpeningId(item.publicationId);
    setOpenFailed(false);
    try {
      const payload = await openFeaturedSet(item.publicationId);
      sessionStorage.setItem(
        HANDOFF_KEY,
        JSON.stringify({
          sessionId: null,
          sessionUid: payload.sessionUid,
          questions: payload.questions,
          title: payload.title,
          mode: 'featured',
        }),
      );
      navigate(
        `/student/training/targeted/run?subjectId=${payload.subjectId}&returnTo=${encodeURIComponent('/student/profile')}`,
      );
    } catch {
      setOpenFailed(true);
      setOpeningId(null);
    }
  };

  const totalPages = list ? Math.max(1, Math.ceil(list.total / PAGE_SIZE)) : 1;

  return (
    <Card data-testid="featured-sets-card" className="p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-bold text-[var(--text-primary)]">精选题单</h2>
        {unread && unread.count > 0 && (
          <span className="shrink-0 rounded-full bg-[var(--brand-500)]/10 px-2 py-0.5 text-xs font-semibold text-[var(--brand-600)]">
            {`${unread.count} 条未读`}
          </span>
        )}
      </div>

      {listFailed ? (
        <p className="mt-4 text-sm text-[var(--text-secondary)]">精选题单暂时加载失败</p>
      ) : !list ? (
        <div data-testid="featured-sets-skeleton" className="mt-4 space-y-3">
          <Skeleton width="100%" height={44} />
        </div>
      ) : list.items.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--text-secondary)]">暂无精选题单</p>
      ) : (
        <ul className="mt-2 divide-y divide-[var(--bg-subtle)]">
          {list.items.map((item) => (
            <li key={item.publicationId} className="flex items-center justify-between gap-4 py-3">
              <button
                type="button"
                disabled={openingId !== null}
                onClick={() => void open(item)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:opacity-60"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-[var(--text-primary)]">
                    {item.title}
                  </span>
                  <span className="block text-xs text-[var(--text-tertiary)]">
                    {`${item.subjectName} · ${item.questionCount} 题`}
                  </span>
                </span>
                {!item.isRead && (
                  <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-[var(--brand-600)]">
                    <UnreadDot />
                    新
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {openFailed && (
        <p className="mt-2 text-sm text-[var(--text-secondary)]">开题失败，请重试</p>
      )}

      {list && list.total > 0 && (
        <div className="mt-4 flex items-center justify-between">
          <Button
            variant="ghost"
            size="sm"
            disabled={list.page <= 1}
            onClick={() => setPage(list.page - 1)}
          >
            上一页
          </Button>
          <span className="text-xs text-[var(--text-secondary)]">
            {`第 ${list.page} / ${totalPages} 页`}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={list.page >= totalPages}
            onClick={() => setPage(list.page + 1)}
          >
            下一页
          </Button>
        </div>
      )}
    </Card>
  );
}
