import clsx from 'clsx';

interface ProgressProps {
  value: number;
  max?: number;
  variant?: 'linear' | 'ring' | 'orbit';
  size?: number;
  label?: string;
  showPercent?: boolean;
  className?: string;
}

export function Progress({
  value,
  max = 100,
  variant = 'linear',
  size = 80,
  label,
  showPercent,
  className,
}: ProgressProps) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));

  if (variant === 'linear') {
    return (
      <div className={clsx('w-full', className)}>
        {label && <div className="flex justify-between text-sm mb-1 text-[var(--text-secondary)]">
          <span>{label}</span>
          {showPercent && <span>{Math.round(pct)}%</span>}
        </div>}
        <div className="w-full h-2 bg-[var(--bg-subtle)] rounded-full overflow-hidden">
          <div
            className="h-full bg-[var(--brand-500)] rounded-full transition-all duration-500 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    );
  }

  if (variant === 'ring') {
    const r = size / 2 - 8;
    const c = 2 * Math.PI * r;
    return (
      <div className={clsx('relative inline-flex items-center justify-center', className)} style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--bg-subtle)" strokeWidth={8} />
          <circle
            cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--brand-500)" strokeWidth={8}
            strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} strokeLinecap="round"
            className="transition-all duration-500 ease-out"
          />
        </svg>
        <div className="absolute text-sm font-semibold text-[var(--text-primary)]">
          {showPercent ? `${Math.round(pct)}%` : label}
        </div>
      </div>
    );
  }

  // orbit (planet)
  return (
    <div className={clsx('relative', className)} style={{ width: size, height: size }}>
      <div className="absolute inset-0 rounded-full border-2 border-dashed border-[var(--text-tertiary)] opacity-30" />
      <div
        className="absolute w-4 h-4 rounded-full bg-[var(--brand-500)] shadow-[var(--shadow-glow-brand)]"
        style={{
          top: '50%', left: '50%',
          transform: `rotate(${pct * 3.6}deg) translateX(${size / 2 - 8}px) rotate(-${pct * 3.6}deg)`,
          marginLeft: -8, marginTop: -8,
          transition: 'transform 500ms ease-out',
        }}
      />
    </div>
  );
}