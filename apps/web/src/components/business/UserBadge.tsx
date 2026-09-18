import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { LevelIcon, Skeleton } from '@/components/base';
import { getMyPoints, type MyPoints } from '@/services/api';
import { LevelPanel } from './LevelPanel';

/**
 * 学生端用户信息入口：药丸 = 头像 + 名字 + 段位图标 + 可用积分，
 * **点击打开段位面板**（不再是退出）。退出由旁边独立的 `LogoutButton` 承担。
 *
 * 两条口径（计划 §2.5 / §3 Task 4）：
 * - mount 时拉一次概览，**加载完成前显示骨架**——绝不渲染「劈柴 0 分」
 *   （段位没加载出来就说 0 分，孩子会以为积分归零）；
 * - 加载失败静默降级：只留头像 + 名字，不显示段位/积分、不弹错误。
 *   用户信息入口不该因为积分接口挂了而报错。
 */

interface UserBadgeProps {
  username: string;
  /** 头像字符；缺省取 `username` 首字符（英文自动大写，与旧头像一致） */
  initial?: string;
  /** 第二行小字（课程详情侧栏「专注学习中...」用），不传则只显示一行 */
  subtitle?: string;
  className?: string;
}

export function UserBadge({ username, initial, subtitle, className }: UserBadgeProps) {
  const [open, setOpen] = useState(false);
  const [points, setPoints] = useState<MyPoints | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMyPoints()
      .then((res) => {
        if (cancelled) return;
        setPoints(res);
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('failed');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const avatarText = initial ?? (username ? username.charAt(0).toUpperCase() : '学');

  return (
    <div ref={rootRef} className={clsx('relative', className)}>
      <button
        type="button"
        data-testid="user-badge"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${username} · 段位与积分`}
        onClick={() => setOpen((prev) => !prev)}
        className="flex items-center gap-2 rounded-[var(--radius-pill)] border border-[var(--bg-subtle)] bg-[var(--bg-elevated)] px-2.5 py-1.5 shadow-sm transition-colors hover:bg-[var(--bg-subtle)]"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--brand-500)] text-xs font-bold text-white">
          {avatarText}
        </span>
        <span className="flex min-w-0 flex-col items-start leading-tight">
          <span className="max-w-[8rem] truncate text-sm font-medium text-[var(--text-primary)]">
            {username}
          </span>
          {subtitle && (
            <span className="max-w-[8rem] truncate text-xs text-[var(--text-tertiary)]">
              {subtitle}
            </span>
          )}
        </span>

        {status === 'loading' && (
          <span data-testid="user-badge-points-skeleton" className="shrink-0">
            <Skeleton width={44} height={16} rounded />
          </span>
        )}

        {status === 'ready' && points && (
          <>
            <span
              data-testid="user-badge-level-icon"
              className="flex shrink-0 items-center text-[var(--brand-600)]"
            >
              <LevelIcon code={points.level.code} size={16} />
            </span>
            <span
              data-testid="user-badge-balance"
              className="shrink-0 text-sm font-semibold tabular-nums text-[var(--brand-600)]"
            >
              {points.balance}
            </span>
          </>
        )}
      </button>

      <LevelPanel open={open} onClose={() => setOpen(false)} anchorRef={rootRef} />
    </div>
  );
}
