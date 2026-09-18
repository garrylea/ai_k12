import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { Button, Card, Skeleton, toast } from '@/components/base';
import {
  ApiError,
  getParentRedemptions,
  setRedemptionStatus,
  type RedemptionList,
  type RedemptionStatus,
  type RedemptionView,
} from '@/services/api';

/**
 * 「兑换记录」Tab（计划三 §2.7，Task 8）。
 *
 * 本组件的四条要点：
 *
 * 1. **列表分页走服务端**：`pageSize` 由服务端固定 20，前端**不传**；下一页用服务端
 *    回显的 `page + 1` 推，`total` 只用来判断「还有没有下一页」。渲染一致性用
 *    「数据自报家门」：响应体里的 `page` 与当前页对不上就不渲染（等同还没到货），
 *    翻页时因此自然退回骨架，不会让页码与新页内容错配。
 * 2. **兑现队列**（UX P6.7）：顶部「待兑现 N 条」chip 默认显示全部，点一下只看
 *    `pending`；`pending` 行「确认已兑现」、`fulfilled` 行「改回待兑现」，都只
 *    `PATCH` 状态、**不动积分**（服务端保证）。成功后重拉当前页。
 *    `N` 是**当前页**的 pending 条数——后端只回分页 items，没有 pending 总数端点；
 *    若要全量计数得新增接口（本期不做），这里如实按本页算。
 * 3. **扣除积分是负数但用中性色**：它是消费，不是错误——**绝不用 `--error`**
 *    （与个人中心流水行的口径一致）。
 * 4. **与 Task 7 的刷新缝**：页面在兑换成功后自增 `refreshToken` 传进来，本组件据此
 *    重拉当前页。注意本面板是按 Tab 条件渲染的（平时并不挂载），所以切到本 Tab 时
 *    本来就会重新取数；`refreshToken` 是那条缝的显式约定，保证「页面知道这里已经有
 *    新数据」这件事有据可依，而不是靠「反正会重挂载」。
 */
export interface RedemptionHistoryPanelProps {
  studentId: number;
  /** 页面在兑换成功后自增；变化即重拉当前页（见文件头第 4 条）。 */
  refreshToken?: number;
}

interface LoadedList {
  studentId: number;
  value: RedemptionList;
}

function formatDateTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 内容列：换钱看金额、换奖励看名字快照（奖励后来改名/软删也不变）。 */
function contentOf(item: RedemptionView): string {
  if (item.type === 'cash') {
    return `¥${(item.cashAmount ?? 0).toFixed(2)}`;
  }
  return item.rewardName ?? '奖励';
}

export default function RedemptionHistoryPanel({
  studentId,
  refreshToken = 0,
}: RedemptionHistoryPanelProps) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<LoadedList | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  /** 只看待兑现（默认显示全部）。 */
  const [pendingOnly, setPendingOnly] = useState(false);
  /** 正在流转状态的那一行（按钮 loading，防重复点）。 */
  const [actingId, setActingId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    getParentRedemptions(studentId, page)
      .then((value) => {
        if (cancelled) return;
        setData({ studentId, value });
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [studentId, page, reload, refreshToken]);

  /**
   * 数据自报家门：不归当前孩子、或回显页号与当前页不符，都当作「还没到货」。
   * 翻页时因此直接显示骨架（不留上一页的行造成页码/内容错配），而状态流转后的
   * 重拉（同一页）继续展示旧行直到新数据替换，不闪。
   */
  const list =
    data && data.studentId === studentId && data.value.page === page ? data.value : null;

  const changeStatus = async (item: RedemptionView, status: RedemptionStatus) => {
    setActingId(item.id);
    try {
      await setRedemptionStatus(item.id, status);
      toast('success', status === 'fulfilled' ? '已标记为已兑现' : '已改回待兑现');
      setReload((n) => n + 1);
    } catch (err: unknown) {
      const message = err instanceof Error && err.message ? err.message : '操作失败';
      toast('error', message);
      // 404 / 1002（兑换单不存在，如被别的端删了）→ 列表已过时，重拉
      if (err instanceof ApiError && err.code === 1002) setReload((n) => n + 1);
    } finally {
      setActingId(null);
    }
  };

  const totalPages = list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1;
  const pendingCount = list ? list.items.filter((item) => item.status === 'pending').length : 0;
  const rows = list
    ? pendingOnly
      ? list.items.filter((item) => item.status === 'pending')
      : list.items
    : [];

  return (
    <Card data-testid="redemption-history" data-student-id={studentId} className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-bold text-[var(--text-primary)]">兑换记录</h2>
        <button
          type="button"
          data-testid="redemption-pending-chip"
          aria-pressed={pendingOnly}
          onClick={() => setPendingOnly((v) => !v)}
          className={clsx(
            'rounded-[var(--radius-pill)] border px-3 py-1 text-xs font-medium transition-colors',
            pendingOnly
              ? 'border-[var(--brand-500)] bg-[var(--brand-100)] text-[var(--brand-600)]'
              : 'border-[var(--bg-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]',
          )}
        >
          {`待兑现 ${pendingCount} 条`}
        </button>
      </div>

      {failed ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
          <span className="text-sm text-[var(--text-secondary)]">兑换记录暂时加载失败</span>
          <Button variant="secondary" size="sm" onClick={() => setReload((n) => n + 1)}>
            重试
          </Button>
        </div>
      ) : list === null ? (
        <div data-testid="redemption-skeleton" className="mt-4 space-y-3">
          <Skeleton width="100%" height={44} />
          <Skeleton width="100%" height={44} />
          <Skeleton width="100%" height={44} />
        </div>
      ) : list.items.length === 0 ? (
        <div className="mt-6 text-center">
          <p className="text-sm text-[var(--text-secondary)]">暂无兑换记录</p>
          <Link
            to="/parent/rewards?tab=redeem"
            className="mt-2 inline-block text-sm font-medium text-[var(--brand-600)] hover:underline"
          >
            去兑换
          </Link>
        </div>
      ) : rows.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--text-secondary)]">本页暂无待兑现记录</p>
      ) : (
        <ul className="mt-2 divide-y divide-[var(--bg-subtle)]">
          {rows.map((item) => (
            <li
              key={item.id}
              data-testid={`redemption-row-${item.id}`}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3"
            >
              <span className="w-32 shrink-0 text-xs text-[var(--text-tertiary)]">
                {formatDateTime(item.createdAt)}
              </span>
              <span className="w-14 shrink-0 text-sm text-[var(--text-secondary)]">
                {item.type === 'cash' ? '换钱' : '换奖励'}
              </span>
              <span
                data-testid={`redemption-content-${item.id}`}
                className="min-w-0 flex-1 truncate text-sm text-[var(--text-primary)]"
              >
                {contentOf(item)}
              </span>
              {/* 扣分：负数、中性色（消费不是错误，绝不用 --error） */}
              <span
                data-testid={`redemption-points-${item.id}`}
                className="w-20 shrink-0 text-right text-sm font-semibold tabular-nums text-[var(--text-secondary)]"
              >
                {`-${item.pointsSpent} 分`}
              </span>

              <div className="flex w-full shrink-0 items-center justify-end gap-3 sm:w-auto">
                {item.status === 'pending' ? (
                  <>
                    <span className="text-xs text-[var(--text-tertiary)]">待兑现</span>
                    <Button
                      data-testid={`redemption-fulfill-${item.id}`}
                      variant="secondary"
                      size="sm"
                      loading={actingId === item.id}
                      onClick={() => void changeStatus(item, 'fulfilled')}
                    >
                      确认已兑现
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="text-xs text-[var(--text-tertiary)]">
                      {`已兑现 ${item.fulfilledAt ? formatDateTime(item.fulfilledAt) : ''}`}
                    </span>
                    <Button
                      data-testid={`redemption-revert-${item.id}`}
                      variant="ghost"
                      size="sm"
                      loading={actingId === item.id}
                      onClick={() => void changeStatus(item, 'pending')}
                    >
                      改回待兑现
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
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
