import clsx from 'clsx';

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  rounded?: boolean;
  className?: string;
}

export function Skeleton({ width = '100%', height = 16, rounded, className }: SkeletonProps) {
  return (
    <div
      className={clsx(
        'animate-pulse bg-[var(--bg-subtle)]',
        rounded ? 'rounded-full' : 'rounded-[var(--radius-button)]',
        className,
      )}
      style={{ width, height }}
    />
  );
}