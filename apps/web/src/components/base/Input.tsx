import { InputHTMLAttributes, forwardRef, ReactNode } from 'react';
import clsx from 'clsx';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  trailing?: ReactNode;
  leading?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, trailing, leading, className, id, ...rest }, ref) => {
    const inputId = id || rest.name;
    return (
      <div className="flex flex-col gap-1.5 w-full">
        {label && (
          <label htmlFor={inputId} className="text-sm font-medium text-[var(--text-secondary)]">
            {label}
          </label>
        )}
        <div
          className={clsx(
            'flex items-center gap-2 px-4 h-12',
            'rounded-[var(--radius-button)] bg-[var(--bg-card)]',
            'border-2 border-[var(--bg-subtle)]',
            'focus-within:border-[var(--brand-500)] focus-within:shadow-[var(--shadow-glow-brand)]',
            'transition-all',
            error && 'border-[var(--error)]',
          )}
        >
          {leading && <span className="text-[var(--text-tertiary)]">{leading}</span>}
          <input
            ref={ref}
            id={inputId}
            className={clsx(
              'flex-1 bg-transparent outline-none text-[var(--text-primary)]',
              'placeholder:text-[var(--text-placeholder)]',
              className,
            )}
            {...rest}
          />
          {trailing && <span className="text-[var(--text-tertiary)]">{trailing}</span>}
        </div>
        {error && <span className="text-xs text-[var(--error)]">{error}</span>}
      </div>
    );
  },
);

Input.displayName = 'Input';
