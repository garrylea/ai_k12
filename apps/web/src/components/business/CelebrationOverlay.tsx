import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { LevelIcon } from '@/components/base';
import { FireworksCanvas } from './FireworksCanvas';
import { useThemeStore } from '@/store/themeStore';

/**
 * 全屏庆祝层（主线课程完成 / 段位晋升共用）。
 *
 * 颜色一律走 CSS 变量：训练轨页面硬编码 `data-theme="student-day"`，
 * `StudentLayout` 页面跟随主题，两处都必须正确（计划 §1.2 第 3 条）。
 * `z-50` 有意高于轻反馈 `PointsToast` 的 `z-40`——轻反馈不该盖住全屏庆祝。
 */

interface CelebrationOverlayProps {
  open: boolean;
  variant: 'task' | 'levelup';
  /** 如「本节学习完成！」/「晋升 铸铁！」 */
  title: string;
  subtitle?: string;
  /** 只读展示；> 0 时才渲染 */
  pointsAwarded?: number;
  /** levelup 时显示大图标 + 段位名 */
  level?: { code: string; name: string };
  primaryLabel: string;
  onPrimary: () => void;
  /** 给了就倒计时自动触发 onPrimary */
  autoCloseSeconds?: number;
}

/** 系统级降级：`typeof` 双保险，jsdom 与部分老旧 WebView 没有 matchMedia。 */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** 完成态对勾（线性描边，与仓内图标同风格） */
function CheckCircleIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={56}
      height={56}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="9 12 12 15 16 10" />
    </svg>
  );
}

export function CelebrationOverlay({
  open,
  variant,
  title,
  subtitle,
  pointsAwarded,
  level,
  primaryLabel,
  onPrimary,
  autoCloseSeconds,
}: CelebrationOverlayProps) {
  const motionEnabled = useThemeStore((s) => s.motionEnabled);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  // 倒计时回调经 ref 读取：autoClose 的 interval 不因父组件换闭包而重启
  const onPrimaryRef = useRef(onPrimary);
  onPrimaryRef.current = onPrimary;
  // 初值直接取 prop，避免开场第一帧闪一下「正在继续...」
  const [remaining, setRemaining] = useState(autoCloseSeconds ?? 0);
  const [fireworksDone, setFireworksDone] = useState(false);

  const animate = motionEnabled && !prefersReducedMotion();
  const showStaticGlow = !animate || fireworksDone;

  // 关闭时复位烟花与倒计时；打开时把焦点交给主按钮（无障碍：焦点落在唯一操作上）
  useEffect(() => {
    if (!open) {
      setFireworksDone(false);
      // 关闭时复位倒计时：下次打开从满值开始，而不是上一轮的残留数字
      setRemaining(autoCloseSeconds ?? 0);
      return;
    }
    primaryRef.current?.focus();
  }, [open, autoCloseSeconds]);

  // 倒计时：只有给了 autoCloseSeconds 才启动；到点自动触发 onPrimary（等价手动点主按钮）
  useEffect(() => {
    if (!open || !autoCloseSeconds) return;
    let left = autoCloseSeconds;
    setRemaining(left);
    const timer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(timer);
        setRemaining(0);
        onPrimaryRef.current();
        return;
      }
      setRemaining(left);
    }, 1000);
    return () => clearInterval(timer);
  }, [open, autoCloseSeconds]);

  const showLevelName = variant === 'levelup' && !!level?.name;
  const showPoints = typeof pointsAwarded === 'number' && pointsAwarded > 0;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label={title}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
        >
          {/* 烟花：canvas `pointer-events-none` 铺满遮罩层，永远不挡主按钮点击 */}
          {animate && !fireworksDone && (
            <FireworksCanvas
              active
              intensity={variant === 'task' ? 'soft' : 'full'}
              onDone={() => setFireworksDone(true)}
            />
          )}

          {/* 卡片：半透明遮罩之上，烟花在卡片四周可见（§2.4「遮罩 + 卡片」） */}
          <div className="relative z-10 flex w-full max-w-lg flex-col items-center rounded-[var(--radius-card)] bg-[var(--bg-elevated)] px-8 py-10 shadow-[var(--shadow-elevated)]">
            {/* 主体视觉：levelup = 大段位图标，task = 对勾圆；两者共用静态光晕 */}
            <div className="relative mb-8 flex items-center justify-center">
              {showStaticGlow && (
                <div
                  data-testid="celebration-glow"
                  aria-hidden="true"
                  className="absolute h-56 w-56 rounded-full blur-3xl"
                  style={{ background: 'var(--brand-100)' }}
                />
              )}
              {variant === 'levelup' ? (
                <div
                  data-testid="celebration-level-icon"
                  className="relative z-10"
                  style={{ color: 'var(--brand-600)' }}
                >
                  <LevelIcon code={level?.code ?? ''} size={96} />
                </div>
              ) : (
                <div
                  data-testid="celebration-task-icon"
                  className="relative z-10 flex h-24 w-24 items-center justify-center rounded-full border-4"
                  style={{
                    // 用实心 `--success` + 白勾（`--text-on-brand`）而不是 `--brand-100` 做底：
                    // 夜间 `--brand-100` 是 rgba(201,213,229,.2)，铺在白色卡片上几乎透明，
                    // 绿环就变成「没有底色的孤立圆环」。同语义族的实心绿在两个主题下都读得出来。
                    background: 'var(--success)',
                    borderColor: 'var(--success)',
                    color: 'var(--text-on-brand)',
                  }}
                >
                  <CheckCircleIcon />
                </div>
              )}
            </div>

            {/* 文案 */}
            <div className="w-full space-y-3 text-center">
              <h2 className="text-3xl font-extrabold leading-snug tracking-tight text-[var(--text-primary)] md:text-4xl">
                {title}
              </h2>
              {showLevelName && (
                <p className="text-lg font-semibold" style={{ color: 'var(--brand-600)' }}>
                  {level?.name}
                </p>
              )}
              {subtitle && (
                <p className="text-sm font-semibold text-[var(--text-secondary)]">{subtitle}</p>
              )}
              {showPoints && (
                <p className="text-sm font-semibold" style={{ color: 'var(--brand-600)' }}>
                  {`+${pointsAwarded} 分`}
                </p>
              )}
              {!!autoCloseSeconds && (
                <p className="text-sm font-semibold text-[var(--text-secondary)]">
                  {remaining > 0 ? `${remaining} 秒后自动继续` : '正在继续...'}
                </p>
              )}
            </div>

            {/* 主按钮 */}
            <div className="pt-8">
              <button
                ref={primaryRef}
                onClick={onPrimary}
                className="flex items-center gap-2.5 rounded-[var(--radius-button)] bg-[var(--learn-btn-primary)] px-10 py-4 font-semibold tracking-wide text-white shadow-md transition-all duration-300 hover:scale-[1.02] hover:bg-[var(--learn-btn-primary-hover)]"
              >
                <span>{primaryLabel}</span>
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
