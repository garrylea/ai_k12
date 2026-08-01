import clsx from 'clsx';
import { motion } from 'framer-motion';

export type PlanetSize = 'large' | 'medium' | 'small';
export type PlanetStatus = 'completed' | 'current' | 'locked';

interface PlanetNodeProps {
  size: PlanetSize;
  status: PlanetStatus;
  label: string;
  sublabel?: string;
  selected?: boolean;
  onClick?: () => void;
}

// Sizes in rem (÷16 from px) so the planet scales with the fluid root
// font-size instead of being pinned to device px in inline styles.
const sizeMap: Record<PlanetSize, number> = {
  large: 5,   // 80px @root16
  medium: 3.5, // 56px
  small: 2.5,  // 40px
};

const labelSizeMap: Record<PlanetSize, string> = {
  large: 'text-base',
  medium: 'text-sm',
  small: 'text-xs',
};

export function PlanetNode({
  size,
  status,
  label,
  sublabel,
  selected,
  onClick,
}: PlanetNodeProps) {
  const rem = sizeMap[size];        // planet diameter in rem
  const dim = `${rem}rem`;          // width/height
  const ringDim = `${rem + 0.75}rem`; // selection ring (was px + 12)
  const ringOffset = '-0.375rem';   // was -6px
  const clickable = status !== 'locked';

  const colors: Record<PlanetStatus, { fill: string; glow: string; ring: string }> = {
    completed: {
      fill: 'var(--success)',
      glow: 'rgba(74, 155, 110, 0.25)',
      ring: 'var(--success)',
    },
    current: {
      fill: 'var(--brand-500)',
      glow: 'rgba(229, 90, 43, 0.35)',
      ring: 'var(--brand-500)',
    },
    locked: {
      fill: 'var(--bg-subtle)',
      glow: 'transparent',
      ring: 'var(--text-tertiary)',
    },
  };
  const c = colors[status];

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        onClick={clickable ? onClick : undefined}
        disabled={!clickable}
        className={clsx(
          'relative flex items-center justify-center transition-all',
          clickable && 'cursor-pointer hover:scale-105',
          !clickable && 'cursor-not-allowed',
        )}
        style={{ width: dim, height: dim }}
        aria-label={`${label}${status === 'locked' ? '（未解锁）' : ''}`}
      >
        {/* 选中环 */}
        {selected && (
          <motion.div
            className="absolute rounded-full border-2"
            style={{
              borderColor: 'var(--brand-500)',
              width: ringDim,
              height: ringDim,
              top: ringOffset,
              left: ringOffset,
            }}
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.2 }}
          />
        )}

        {/* 当前节点脉动光晕 */}
        {status === 'current' && (
          <motion.div
            className="absolute rounded-full"
            style={{ width: dim, height: dim, boxShadow: `0 0 ${rem / 2}rem ${c.glow}` }}
            animate={{ scale: [1, 1.15, 1] }}
            transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
          />
        )}

        {/* 完成节点柔光 */}
        {status === 'completed' && (
          <div
            className="absolute rounded-full"
            style={{ width: dim, height: dim, boxShadow: `0 0 ${rem / 3}rem ${c.glow}` }}
          />
        )}

        {/* 星球本体 */}
        <svg width={dim} height={dim} viewBox="0 0 100 100">
          <defs>
            <radialGradient id={`grad-${size}-${status}`} cx="35%" cy="35%">
              <stop offset="0%" stopColor="rgba(255,255,255,0.4)" />
              <stop offset="100%" stopColor={c.fill} />
            </radialGradient>
          </defs>
          <circle cx="50" cy="50" r="38" fill={`url(#grad-${size}-${status})`} stroke={c.ring} strokeWidth="2" strokeOpacity="0.5" />

          {/* 已完成 - 勾选 */}
          {status === 'completed' && (
            <path
              d="M 35 50 L 45 60 L 65 38"
              stroke="white"
              strokeWidth="5"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}

          {/* 当前 - 实心圆点 */}
          {status === 'current' && (
            <circle cx="50" cy="50" r="6" fill="white" />
          )}

          {/* 锁定 - 锁图标 */}
          {status === 'locked' && (
            <>
              <rect x="42" y="42" width="16" height="14" rx="2" fill="var(--text-tertiary)" />
              <path
                d="M 46 42 V 38 A 4 4 0 0 1 54 38 V 42"
                stroke="var(--text-tertiary)"
                strokeWidth="2.5"
                fill="none"
                strokeLinecap="round"
              />
            </>
          )}
        </svg>
      </button>

      {/* 标签 */}
      <div className="text-center max-w-[7.5rem]">
        <div
          className={clsx(
            'font-semibold',
            labelSizeMap[size],
            status === 'locked'
              ? 'text-[var(--text-tertiary)]'
              : 'text-[var(--text-primary)]',
          )}
        >
          {label}
        </div>
        {sublabel && (
          <div className="text-xs text-[var(--text-tertiary)] mt-0.5">{sublabel}</div>
        )}
      </div>
    </div>
  );
}
