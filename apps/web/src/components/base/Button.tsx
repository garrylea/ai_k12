import { ButtonHTMLAttributes, forwardRef } from 'react';
import clsx from 'clsx';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg' | 'xl';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: React.ReactNode;
}

const variantStyles: Record<Variant, string> = {
  primary:
    'bg-[var(--brand-500)] text-[var(--text-on-brand)] hover:bg-[var(--brand-400)] active:bg-[var(--brand-600)] shadow-[var(--shadow-card)]',
  secondary:
    'bg-transparent text-[var(--brand-500)] border-2 border-[var(--brand-500)] hover:bg-[var(--brand-100)]',
  ghost:
    'bg-transparent text-[var(--text-primary)] hover:bg-[var(--bg-subtle)]',
  danger:
    'bg-[var(--error)] text-white hover:opacity-90',
};

const sizeStyles: Record<Size, string> = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-10 px-4 text-base',
  lg: 'h-12 px-6 text-lg min-w-[44px]',
  xl: 'h-14 px-8 text-xl min-w-[56px]',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'lg', loading, icon, className, children, disabled, ...rest }, ref) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={clsx(
          'inline-flex items-center justify-center gap-2 font-semibold transition-all',
          'rounded-[var(--radius-button)] select-none',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--brand-100)]',
          variantStyles[variant],
          sizeStyles[size],
          className,
        )}
        {...rest}
      >
        {loading ? (
          <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
        ) : icon ? (
          <span className="inline-flex">{icon}</span>
        ) : null}
        {children}
      </button>
    );
  },
);

Button.displayName = 'Button';
