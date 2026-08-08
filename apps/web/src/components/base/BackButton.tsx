import { ButtonHTMLAttributes } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';

interface BackButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Navigation target path */
  to: string;
  /** Optional destination label, shown next to the icon + used for title / aria-label */
  label?: string;
  /** Optional navigation state (e.g. { subjectId }) */
  state?: unknown;
}

const ArrowLeftIcon = () => (
  <svg
    className="w-5 h-5"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

/**
 * 统一的返回控件：圆形白底图标 + 可选文字（紧挨图标），指定 `to` 即跳转。
 * 风格基准为知识星图（StarMapPage）的返回按钮。
 */
export function BackButton({ to, label, state, className, ...rest }: BackButtonProps) {
  const navigate = useNavigate();
  const accessibleLabel = label || '返回';
  return (
    <button
      {...rest}
      type="button"
      onClick={() => navigate(to, state !== undefined ? { state } : undefined)}
      title={accessibleLabel}
      aria-label={accessibleLabel}
      className={clsx('inline-flex items-center gap-1.5 text-slate-600', className)}
    >
      <span
        className={clsx(
          'inline-flex items-center justify-center p-2.5 rounded-full',
          'bg-white border border-slate-200 shadow-sm',
          'hover:bg-slate-50 transition-colors',
        )}
      >
        <ArrowLeftIcon />
      </span>
      {label ? <div className="text-sm font-medium">{label}</div> : null}
    </button>
  );
}
