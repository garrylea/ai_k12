import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Button, Card, LevelIcon, Progress, Skeleton } from '@/components/base';
import {
  getMyLedger,
  getMyPoints,
  type MyPoints,
  type PointLedgerEntry,
  type PointLedgerPage,
} from '@/services/api';

/**
 * 个人中心（计划 §3 Task 5 / spec §8.1）——`StudentLayout` 子路由，**跟随日夜主题**，
 * 所以颜色一律走 CSS 变量，不写死 `data-theme`、不按主题分支。
 *
 * 三块：段位大卡 → 积分概览 → 积分流水（分页）+ 兑换记录。
 *
 * **兑换记录的数据来源**：学生端**没有**兑换记录端点（`me/redemptions` 不存在，
 * 带 `pending`/`fulfilled` 状态的兑换单只有家长端 `GET /api/parent/students/:id/redemptions` 才有）。
 * 这里用**当前页流水里 `kind === 'redeem'` 的行**渲染，并明说范围与「以家长端为准」——
 * 明明可能有兑换行却报「还没有兑换记录」是对用户撒谎，所以空态文案只声明本页范围。
 */

/** 流水行的分数样式：加分用语义绿；`redeem` 的负分**用中性色**（不是错误，绝不用 --error）。 */
function pointsClassName(points: number): string {
  return clsx(
    'shrink-0 text-sm font-semibold tabular-nums',
    points >= 0 ? 'text-[var(--success)]' : 'text-[var(--text-secondary)]',
  );
}

function formatDateTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function LedgerRow({ entry, testIdPrefix }: { entry: PointLedgerEntry; testIdPrefix: string }) {
  return (
    <li className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="truncate text-sm text-[var(--text-primary)]">{entry.title}</div>
        <div className="text-xs text-[var(--text-tertiary)]">{formatDateTime(entry.createdAt)}</div>
      </div>
      <span data-testid={`${testIdPrefix}-${entry.id}`} className={pointsClassName(entry.points)}>
        {entry.points >= 0 ? `+${entry.points} 分` : `${entry.points} 分`}
      </span>
    </li>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-[var(--text-secondary)]">{label}</div>
      <div className="mt-1 text-xl font-bold tabular-nums text-[var(--text-primary)]">
        {`${value} 分`}
      </div>
    </Card>
  );
}

export default function ProfilePage() {
  const [points, setPoints] = useState<MyPoints | null>(null);
  const [pointsFailed, setPointsFailed] = useState(false);
  const [page, setPage] = useState(1);
  const [ledger, setLedger] = useState<PointLedgerPage | null>(null);
  const [ledgerFailed, setLedgerFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getMyPoints()
      .then((res) => {
        if (!cancelled) setPoints(res);
      })
      .catch(() => {
        if (!cancelled) setPointsFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    // 翻页先退回骨架：留着上一页的行会让页码与内容错配
    setLedger(null);
    setLedgerFailed(false);
    getMyLedger(page)
      .then((res) => {
        if (!cancelled) setLedger(res);
      })
      .catch(() => {
        if (!cancelled) setLedgerFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [page]);

  const loading = !points && !pointsFailed;
  const totalPages = ledger ? Math.max(1, Math.ceil(ledger.total / ledger.pageSize)) : 1;
  const redeemRows = ledger ? ledger.items.filter((entry) => entry.kind === 'redeem') : [];

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
      <h1 className="text-2xl font-black tracking-tight text-[var(--text-primary)]">个人中心</h1>

      {loading ? (
        <div data-testid="profile-skeleton" className="space-y-6">
          <Skeleton width="100%" height={150} rounded />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Skeleton width="100%" height={84} rounded />
            <Skeleton width="100%" height={84} rounded />
            <Skeleton width="100%" height={84} rounded />
          </div>
          <Skeleton width="100%" height={220} rounded />
        </div>
      ) : (
        <>
          {/* 概览挂了只降级这一块：流水与兑换记录是另一个请求，不该被连坐 */}
          {!points ? (
            <Card className="p-6 text-sm text-[var(--text-secondary)]">
              积分信息暂时加载失败
            </Card>
          ) : (
            <>
              {/* 段位大卡 */}
              <Card className="p-6">
                <div className="flex items-center gap-4">
                  <span
                    data-testid="profile-level-icon"
                    className="shrink-0 text-[var(--brand-600)]"
                  >
                    <LevelIcon code={points.level.code} size={64} />
                  </span>
                  <div className="min-w-0">
                    <div className="text-xl font-bold text-[var(--text-primary)]">
                      {points.level.name}
                    </div>
                    <div className="text-xs text-[var(--text-tertiary)]">
                      {`累计 ${points.totalEarned} 分`}
                    </div>
                  </div>
                </div>

                <div className="mt-5">
                  <Progress value={points.nextLevel ? points.progressPercent : 100} />
                  <div className="mt-2 flex flex-wrap items-baseline gap-x-2 text-xs">
                    {points.nextLevel ? (
                      <>
                        <span className="text-[var(--text-secondary)]">
                          {`还差 ${points.pointsToNextLevel} 分`}
                        </span>
                        <span className="text-[var(--text-tertiary)]">
                          {`升级到「${points.nextLevel.name}」`}
                        </span>
                      </>
                    ) : (
                      <span className="text-[var(--text-secondary)]">已达最高段位</span>
                    )}
                  </div>
                </div>
              </Card>

              {/* 积分概览 */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <StatCard label="可用积分" value={points.balance} />
                <StatCard label="累计获得" value={points.totalEarned} />
                <StatCard label="今日获得" value={points.todayEarned} />
              </div>
            </>
          )}

          {/* 积分流水 */}
          <Card className="p-6">
            <h2 className="text-base font-bold text-[var(--text-primary)]">积分流水</h2>

            {ledgerFailed ? (
              <p className="mt-4 text-sm text-[var(--text-secondary)]">积分流水暂时加载失败</p>
            ) : !ledger ? (              <div data-testid="ledger-skeleton" className="mt-4 space-y-3">
                <Skeleton width="100%" height={44} />
                <Skeleton width="100%" height={44} />
                <Skeleton width="100%" height={44} />
              </div>
            ) : ledger.items.length === 0 ? (
              <p className="mt-4 text-sm text-[var(--text-secondary)]">暂无积分流水</p>
            ) : (
              <ul data-testid="ledger-list" className="mt-2 divide-y divide-[var(--bg-subtle)]">
                {ledger.items.map((entry) => (
                  <LedgerRow key={entry.id} entry={entry} testIdPrefix="ledger-points" />
                ))}
              </ul>
            )}

            {ledger && ledger.total > 0 && (
              <div className="mt-4 flex items-center justify-between">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={ledger.page <= 1}
                  onClick={() => setPage(ledger.page - 1)}
                >
                  上一页
                </Button>
                <span className="text-xs text-[var(--text-secondary)]">
                  {`第 ${ledger.page} / ${totalPages} 页`}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={ledger.page >= totalPages}
                  onClick={() => setPage(ledger.page + 1)}
                >
                  下一页
                </Button>
              </div>
            )}
          </Card>

          {/* 兑换记录：用当前页流水里的兑换行，不额外打多页 */}
          <Card data-testid="redemption-records" className="p-6">
            <h2 className="text-base font-bold text-[var(--text-primary)]">兑换记录</h2>
            <p className="mt-1 text-xs text-[var(--text-tertiary)]">当前页流水中的兑换行</p>
            <p className="mt-2 text-xs text-[var(--text-secondary)]">
              兑换由家长在家长端操作；此处只显示流水，详细状态以家长端为准
            </p>

            {ledgerFailed ? (
              <p className="mt-4 text-sm text-[var(--text-secondary)]">
                积分流水暂时加载失败，兑换记录也无法显示
              </p>
            ) : !ledger ? (
              <div className="mt-4 space-y-3">
                <Skeleton width="100%" height={44} />
              </div>
            ) : redeemRows.length === 0 ? (
              <p className="mt-4 text-sm text-[var(--text-secondary)]">
                当前页流水里没有兑换记录
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-[var(--bg-subtle)]">
                {redeemRows.map((entry) => (
                  <LedgerRow key={entry.id} entry={entry} testIdPrefix="redeem-points" />
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
