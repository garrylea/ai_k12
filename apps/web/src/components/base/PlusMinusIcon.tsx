interface PlusMinusIconProps {
  /** true = 展开态（显示「−」），false = 收起态（显示「+」） */
  open: boolean;
  /** 边长（px），默认 18 对齐 `text-lg` 的字号 */
  size?: number;
  /** 交给调用方控色，如 text-[var(--text-secondary)] */
  className?: string;
}

/**
 * 折叠开关的加/减号图标（线性描边 + currentColor）。
 *
 * 纯装饰：状态语义由外层按钮的 `aria-expanded` 承担，故这里固定 `aria-hidden`，
 * 不让图标混进按钮的可访问名（否则按名字找按钮的用例会因「+」多出一段）。
 */
export function PlusMinusIcon({ open, size = 18, className }: PlusMinusIconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M5 12h14" />
      {!open && <path d="M12 5v14" />}
    </svg>
  );
}
