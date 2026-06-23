import { HTMLAttributes, forwardRef } from 'react';
import clsx from 'clsx';

type Elevation = 'flat' | 'raised' | 'floating';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  elevation?: Elevation;
  interactive?: boolean;
}

const elevationStyles: Record<Elevation, string> = {
  flat: 'bg-[var(--bg-subtle)]',
  raised: 'bg-[var(--bg-card)] shadow-[var(--shadow-card)]',
  floating: 'bg-[var(--bg-elevated)] shadow-[var(--shadow-elevated)]',
};

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ elevation = 'raised', interactive, className, children, ...rest }, ref) => {
    return (
      <div
        ref={ref}
        className={clsx(
          'rounded-[var(--radius-card)] p-4 transition-all',
          elevationStyles[elevation],
          interactive && 'cursor-pointer hover:shadow-[var(--shadow-elevated)] hover:-translate-y-0.5',
          className,
        )}
        {...rest}
      >
        {children}
      </div>
    );
  },
);

Card.displayName = 'Card';
