import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Card, LevelIcon, Skeleton } from '@/components/base';
import { getMyRewards, type MyRewards, type StudentRewardItem } from '@/services/api';

/**
 * 奖励册（计划 §3 Task 5 / spec §8.1）——`StudentLayout` 子路由，**跟随日夜主题**，
 * 颜色一律走 CSS 变量。
 *
 * 口径：
 * - 学生端**不能自助兑换**，兑换由家长在家长端操作，所以页面必须明写「找家长兑换」；
 * - `affordable && levelOk` 才高亮「可兑换」，否则整卡置灰并说清是哪一道门槛没过
 *   （两个门槛可能同时不满足，两条理由都要写出来）；
 * - 「还差 N 分」用接口给的 `gap`；段位名用接口给的 `minLevelName`（`null` = 脏 code，
 *   回退成「更高段位」）——前端不维护段位表，单一真源在服务端 `levels.ts`。
 */

function RewardCard({ item }: { item: StudentRewardItem }) {
  const available = item.affordable && item.levelOk;

  return (
    <Card
      data-testid={`reward-card-${item.id}`}
      data-state={available ? 'available' : 'locked'}
      className={clsx('space-y-3 p-5', !available && 'opacity-60')}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-base font-semibold text-[var(--text-primary)]">{item.name}</div>
          {item.description && (
            <p className="mt-1 text-xs text-[var(--text-secondary)]">{item.description}</p>
          )}
        </div>
        <span className="shrink-0 text-sm font-semibold tabular-nums text-[var(--text-primary)]">
          {`${item.pointsCost} 分`}
        </span>
      </div>

      <div data-testid={`reward-status-${item.id}`} className="text-xs">
        {available ? (
          <span className="inline-flex items-center rounded-[var(--radius-pill)] bg-[var(--brand-100)] px-2 py-0.5 font-semibold text-[var(--brand-600)]">
            可兑换
          </span>
        ) : (
          <div className="space-y-1 text-[var(--text-secondary)]">
            {!item.affordable && <div>{`还差 ${item.gap} 分`}</div>}
            {!item.levelOk && (
              <div>{`段位不够（需达到${item.minLevelName ?? '更高段位'}）`}</div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

export default function RewardsPage() {
  const [data, setData] = useState<MyRewards | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getMyRewards()
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
      <h1 className="text-2xl font-black tracking-tight text-[var(--text-primary)]">奖励册</h1>

      {!data && !failed ? (
        <div data-testid="rewards-skeleton" className="space-y-6">
          <Skeleton width="100%" height={92} rounded />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Skeleton width="100%" height={140} rounded />
            <Skeleton width="100%" height={140} rounded />
          </div>
        </div>
      ) : !data ? (
        <Card className="p-6 text-sm text-[var(--text-secondary)]">奖励信息暂时加载失败</Card>
      ) : (
        <>
          <Card className="p-5">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <div className="flex items-center gap-2">
                <span className="text-[var(--brand-600)]">
                  <LevelIcon code={data.level.code} size={28} />
                </span>
                <span className="text-sm font-semibold text-[var(--text-primary)]">
                  {data.level.name}
                </span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-xs text-[var(--text-secondary)]">可用积分</span>
                <span className="text-lg font-bold tabular-nums text-[var(--text-primary)]">
                  {`${data.balance} 分`}
                </span>
              </div>
            </div>

            <div className="mt-4 border-t border-[var(--bg-subtle)] pt-3">
              <span className="text-sm font-semibold text-[var(--brand-600)]">找家长兑换</span>
              <span className="ml-2 text-xs text-[var(--text-secondary)]">
                奖励由家长在家长端为你兑换，学生端只能看。
              </span>
            </div>
          </Card>

          {data.items.length === 0 ? (
            <Card className="p-6">
              <p className="text-sm text-[var(--text-secondary)]">家长还没有上架奖励</p>
              <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                可以让家长在家长端上架想换的奖励。
              </p>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {data.items.map((item) => (
                <RewardCard key={item.id} item={item} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
