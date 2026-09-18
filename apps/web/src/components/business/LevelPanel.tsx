import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { LevelIcon, Progress, Skeleton } from '@/components/base';
import { getMyPoints, type MyPoints } from '@/services/api';
import {
  GUTTER,
  PANEL_FALLBACK_SIZE,
  clamp,
  computePanelPosition,
  type PanelPosition,
} from './level-panel-position';

/**
 * 段位 / 积分面板——用户点 `UserBadge` 要看的东西（计划 §2.5）。
 *
 * 关键口径：
 * - **打开时自己再调一次 `GET /api/points/me`**（不复用徽章那次请求、也不引入共享 store）。
 * - **加载中用骨架，绝不先渲染 0 分**：段位没出来就说「劈柴 0 分」会让孩子以为积分归零。
 * - 形态：≥1024px（项目主断点）桌面 popover，窄屏底部抽屉；点外部 + Esc 都要能关。
 * - 颜色一律走 CSS 变量：训练轨硬编码日间主题、`StudentLayout` 跟随主题，两处都必须成立。
 */

interface LevelPanelProps {
  open: boolean;
  onClose: () => void;
  /**
   * 桌面 popover 的锚点（徽章根节点）。显式排除它，否则「点按钮开、再点按钮关」
   * 会被「点外部关闭」的 mousedown 先关掉再被 onClick 打开，永远关不上。
   */
  anchorRef?: RefObject<HTMLElement | null>;
}

/** 项目主断点：iPad 横屏 ≥1024px 视作桌面（计划 §1.2 第 4 条）。 */
const DESKTOP_QUERY = '(min-width: 1024px)';

/** jsdom 与部分老旧 WebView 没有 matchMedia：缺省按桌面处理，不抛错。 */
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(DESKTOP_QUERY).matches
      : true,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => setIsDesktop(mql.matches);
    mql.addEventListener?.('change', onChange);
    return () => mql.removeEventListener?.('change', onChange);
  }, []);

  return isDesktop;
}

export function LevelPanel({ open, onClose, anchorRef }: LevelPanelProps) {
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();
  const panelRef = useRef<HTMLDivElement | null>(null);

  const [data, setData] = useState<MyPoints | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  // 每次打开都重新拉一次（面板显示的是「此刻」的积分）
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    setData(null);
    getMyPoints()
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        // 静默降级：面板里给一句中性说明，不弹错误（这不是用户操作失败）
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Esc 关闭（两种形态都适用）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // 桌面 popover：点外部关闭（锚点与面板自身都不算「外部」）
  useEffect(() => {
    if (!open || !isDesktop) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef?.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, isDesktop, onClose, anchorRef]);

  // 桌面 popover 用 fixed 定位：徽章所在容器多带 overflow-hidden
  //（CourseDetailPage / AuxiliaryLayout 都是），absolute 会被裁掉。
  // 尺寸优先实测（文案/字号一变也不失真），量不到时退回兜底常量。
  //
  // ⚠️ 依赖里**必须带 `loading` / `data`**：open 变 true 的那一帧 body 还是兜底
  // 文案（loading 尚未在 effect 里置 true、data 还是 null），实测到的是 ≈76px 的一行；
  // body 随后长到 ≈240px 时若不再测，底部宿主（侧栏页脚 + 视口高 overflow-hidden）
  // 会按一行高翻转，正文连同「查看积分明细 →」整块落到折线以下且滚不到。
  const [pos, setPos] = useState<PanelPosition | null>(null);
  useLayoutEffect(() => {
    if (!open || !isDesktop) {
      setPos(null);
      return;
    }
    const measure = () => {
      const panelRect = panelRef.current?.getBoundingClientRect();
      const size = {
        width: Math.round(panelRect?.width ?? 0) || PANEL_FALLBACK_SIZE.width,
        height: Math.round(panelRect?.height ?? 0) || PANEL_FALLBACK_SIZE.height,
      };
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const anchorRect = anchorRef?.current?.getBoundingClientRect();
      // 锚点缺失或拿到全 0 矩形（jsdom 无布局引擎）→ 退到右上角固定位，不崩
      const hasAnchor =
        !!anchorRect &&
        !(
          anchorRect.width === 0 &&
          anchorRect.height === 0 &&
          anchorRect.top === 0 &&
          anchorRect.bottom === 0
        );
      if (!hasAnchor || !anchorRect) {
        setPos({
          top: clamp(96, GUTTER, viewport.height - size.height - GUTTER),
          left: clamp(viewport.width - size.width - 16, GUTTER, viewport.width - size.width - GUTTER),
        });
        return;
      }
      setPos(computePanelPosition(anchorRect, size, viewport));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
    // loading / data 刻意入依赖：body 从骨架/兜底长成正文后要在同一 commit 内重测
  }, [open, isDesktop, anchorRef, loading, data]);

  // aria-modal 要求焦点进入面板：打开后把焦点交给容器（Esc 监听挂在 document 上，仍能关）。
  // 关闭时把焦点还给打开它的元素——面板一卸载焦点就掉到 <body>，键盘用户会丢位置。
  useEffect(() => {
    if (!open) return;
    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => {
      previous?.focus();
    };
  }, [open]);

  if (!open) return null;

  const body = loading ? (
    <div data-testid="level-panel-skeleton" className="space-y-3">
      <div className="flex items-center gap-3">
        <Skeleton width={44} height={44} rounded />
        <div className="space-y-2">
          <Skeleton width={72} height={18} />
          <Skeleton width={96} height={12} />
        </div>
      </div>
      <Skeleton width="55%" height={28} />
      <Skeleton width="100%" height={8} rounded />
      <Skeleton width="45%" height={12} />
    </div>
  ) : failed || !data ? (
    <div className="py-2 text-sm text-[var(--text-secondary)]">积分信息暂时加载失败</div>
  ) : (
    <>
      <div className="flex items-center gap-3">
        <span data-testid="level-panel-level-icon" className="shrink-0 text-[var(--brand-600)]">
          <LevelIcon code={data.level.code} size={44} />
        </span>
        <div className="min-w-0">
          <div className="truncate text-lg font-semibold text-[var(--text-primary)]">
            {data.level.name}
          </div>
          <div className="text-xs text-[var(--text-tertiary)]">{`累计 ${data.totalEarned} 分`}</div>
        </div>
      </div>

      <div>
        <div className="text-xs text-[var(--text-secondary)]">可用积分</div>
        <div
          data-testid="level-panel-balance"
          className="text-2xl font-bold tabular-nums text-[var(--text-primary)]"
        >
          {`${data.balance} 分`}
        </div>
      </div>

      <div>
        <Progress value={data.nextLevel ? data.progressPercent : 100} />
        <div className="mt-2 flex items-baseline gap-1 text-xs">
          {data.nextLevel ? (
            <>
              <span className="text-[var(--text-secondary)]">{`还差 ${data.pointsToNextLevel} 分`}</span>
              <span className="text-[var(--text-tertiary)]">{`升级到「${data.nextLevel.name}」`}</span>
            </>
          ) : (
            <span className="text-[var(--text-secondary)]">已达最高段位</span>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={() => {
          onClose();
          navigate('/student/profile');
        }}
        className="w-full rounded-[var(--radius-button)] border border-[var(--bg-subtle)] px-3 py-2 text-sm font-medium text-[var(--brand-600)] transition-colors hover:bg-[var(--bg-subtle)]"
      >
        查看积分明细 →
      </button>
    </>
  );

  // 窄屏：底部抽屉（遮罩点击关闭）
  if (!isDesktop) {
    return (
      <div className="fixed inset-0 z-50 flex items-end">
        <div
          data-testid="level-panel-backdrop"
          className="absolute inset-0 bg-black/40"
          onClick={onClose}
        />
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label="积分与段位"
          tabIndex={-1}
          data-testid="level-panel"
          className="relative w-full rounded-t-[var(--radius-card)] bg-[var(--bg-elevated)] px-5 pb-6 pt-5 shadow-[var(--shadow-elevated)] outline-none"
        >
          <div className="space-y-4">{body}</div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="积分与段位"
      tabIndex={-1}
      data-testid="level-panel"
      className="fixed z-50 w-72 rounded-[var(--radius-card)] border border-[var(--bg-subtle)] bg-[var(--bg-elevated)] p-5 shadow-[var(--shadow-elevated)] outline-none"
      style={{ top: pos?.top ?? 96, left: pos?.left ?? 16 }}
    >
      <div className="space-y-4">{body}</div>
    </div>
  );
}
