export interface TierChipProps {
  label: string;
  points: number;
  status: string | null;
  active: boolean;
  capped: boolean;
  onClick: () => void;
}

/** 题量档按钮（单选）：主行档位名，副行分值 + 剩余次数。 */
export function TierChip({
  label,
  points,
  status,
  active,
  capped,
  onClick,
}: TierChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        'flex flex-col items-center justify-center min-h-11 px-4 py-1.5 rounded-full border ' +
        'text-sm font-medium transition-colors ' +
        (active
          ? 'border-[var(--brand-500)] bg-[var(--brand-500)] text-[var(--text-on-brand)]'
          : 'border-[var(--learn-card-border)] bg-[var(--learn-card-bg)] text-[var(--learn-text-secondary)] hover:border-[var(--brand-500)]') +
        (capped && !active ? ' opacity-60' : '')
      }
    >
      <span>{label}</span>
      <span
        className={
          'text-[0.625rem] font-normal ' +
          (active ? 'opacity-90' : 'text-[var(--learn-text-tertiary)]')
        }
      >
        +{points} 分{status ? ` · ${status}` : ''}
      </span>
    </button>
  );
}
