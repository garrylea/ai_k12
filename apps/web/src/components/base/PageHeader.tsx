import { ReactNode } from 'react';
import clsx from 'clsx';
import { BackButton } from './BackButton';

interface PageHeaderProps {
  /** 返回目标路径（与 onBack 二选一；传 onBack 时由调用方自己导航） */
  to?: string;
  /** 自定义返回动作（如先清队列再导航）；传了就不再走 to */
  onBack?: () => void;
  /** 返回按钮的可访问名（不显示文字；默认「返回」/「返回上一页」） */
  backAriaLabel?: string;
  /** 大标题上方的小字说明（返回去向 / 学科名），如「返回训练」 */
  caption?: string;
  /** 页面大标题 */
  title: ReactNode;
  /** BackButton 的导航 state（如 { subjectId }） */
  state?: unknown;
  className?: string;
  /** 覆盖标题默认样式（text-2xl font-black），需要更大字号时用 */
  titleClassName?: string;
  /** 右侧操作区（学生端账号药丸 + 退出）；不传则顶栏保持原样 */
  actions?: ReactNode;
}

/**
 * 统一的页面顶栏：圆形返回按钮（纯图标）+ 上下结构标题——小字 caption 在上、
 * 大标题在下。风格基准为知识星图（StarMapPage）的 header。
 *
 * caption + title 配色固定为日间取值（caption=#ff6b35 brand-500、title=#2A1F18
 * text-primary），与 BackButton 的 text-slate-600/bg-white 一样不随夜间模式变化，
 * 保证沉浸层切夜间时整块顶栏文字与 star-map 页一致且可读。
 */
export function PageHeader({
  to,
  onBack,
  backAriaLabel,
  caption,
  title,
  state,
  className,
  titleClassName,
  actions,
}: PageHeaderProps) {
  return (
    <header
      className={clsx(
        'flex items-center gap-4 border-b border-[var(--bg-subtle)] pb-5',
        // 账号区在窄屏放不下时折到第二行，避免整页出现横向滚动
        actions && 'flex-wrap',
        className,
      )}
    >
      <BackButton to={to} onClick={onBack} ariaLabel={backAriaLabel} state={state} />
      <div className="min-w-0">
        {caption ? (
          <div className="text-sm font-semibold tracking-wide text-[#ff6b35]">
            {caption}
          </div>
        ) : null}
        <h1
          className={clsx(
            'text-2xl font-black tracking-tight text-[#2A1F18]',
            titleClassName,
          )}
        >
          {title}
        </h1>
      </div>
      {actions ? (
        <div data-testid="page-header-actions" className="ml-auto flex shrink-0 items-center gap-2">
          {actions}
        </div>
      ) : null}
    </header>
  );
}
