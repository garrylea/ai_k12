import { ReactNode } from 'react';
import clsx from 'clsx';

interface BannerProps {
  type?: 'warning' | 'danger' | 'info';
  title: string;
  description?: string;
  action?: ReactNode;
  onClose?: () => void;
}

const typeStyles = {
  warning: 'bg-orange-50 border-orange-300 text-orange-900',
  danger: 'bg-[var(--error)] text-white',
  info: 'bg-blue-50 border-blue-300 text-blue-900',
};

export function Banner({ type = 'warning', title, description, action, onClose }: BannerProps) {
  return (
    <div className={clsx(
      'w-full px-6 py-3 flex items-center gap-4',
      'border-b-2 sticky top-0 z-40',
      typeStyles[type],
    )}>
      <div className="flex-1">
        <div className="font-semibold">{title}</div>
        {description && <div className="text-sm opacity-90 mt-0.5">{description}</div>}
      </div>
      {action}
      {onClose && (
        <button onClick={onClose} className="text-2xl leading-none opacity-70 hover:opacity-100">&times;</button>
      )}
    </div>
  );
}