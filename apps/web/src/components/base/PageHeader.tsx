import { ReactNode } from 'react';
import clsx from 'clsx';
import { BackButton } from './BackButton';

interface PageHeaderProps {
  /** 返回目标路径 */
  to: string;
  /** 大标题上方的小字说明（返回去向 / 学科名），如「返回训练」 */
  caption?: string;
  /** 页面大标题 */
  title: ReactNode;
  /** BackButton 的导航 state（如 { subjectId }） */
  state?: unknown;
  className?: string;
  /** 覆盖标题默认样式（text-2xl font-black），需要更大字号时用 */
  titleClassName?: string;
}

/**
 * 统一的页面顶栏：圆形返回按钮（纯图标）+ 上下结构标题——小字 caption 在上、
 * 大标题在下。风格基准为知识星图（StarMapPage）的 header；配色走主题变量，
 * 日间/夜间/家长端主题下均可正确渲染。
 */
export function PageHeader({
  to,
  caption,
  title,
  state,
  className,
  titleClassName,
}: PageHeaderProps) {
  return (
    <header
      className={clsx(
        'flex items-center gap-4 border-b border-[var(--bg-subtle)] pb-5',
        className,
      )}
    >
      <BackButton to={to} state={state} />
      <div className="min-w-0">
        {caption ? (
          <div className="text-sm font-semibold tracking-wide text-[var(--brand-500)]">
            {caption}
          </div>
        ) : null}
        <h1
          className={clsx(
            'text-2xl font-black tracking-tight text-[var(--text-primary)]',
            titleClassName,
          )}
        >
          {title}
        </h1>
      </div>
    </header>
  );
}
