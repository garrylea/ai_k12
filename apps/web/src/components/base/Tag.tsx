import { ReactNode } from 'react';
import clsx from 'clsx';

type TagVariant = 'knowledge' | 'easy' | 'medium' | 'hard' | 'mainline' | 'auxiliary' | 'neutral' | 'source';

interface TagProps {
  children: ReactNode;
  variant?: TagVariant;
  className?: string;
  size?: 'sm' | 'md';
}

const variantStyles: Record<TagVariant, string> = {
  knowledge: 'bg-[var(--brand-100)] text-[var(--brand-600)]',
  easy: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  medium: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  hard: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  mainline: 'bg-[var(--brand-100)] text-[var(--brand-600)]',
  auxiliary: 'bg-[var(--brand-100)] text-[var(--brand-600)]',
  neutral: 'bg-[var(--bg-subtle)] text-[var(--text-secondary)]',
  source: 'bg-[var(--bg-subtle)] text-[var(--text-tertiary)]',
};

export function Tag({ children, variant = 'neutral', size = 'sm', className }: TagProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 font-medium rounded-[var(--radius-pill)]',
        size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm',
        variantStyles[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
