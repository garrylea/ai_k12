/**
 * 统一的「退出/离开」线性图标：门框在左、箭头向右离开门框。
 *
 * 全仓只此一处定义——`LogoutButton` 和浅停留页顶栏的「退出本页」共用，
 * 保证凡是「离开」语义的按钮都用同一个图标（2026-11-06 用户要求）。
 */
export function ExitIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg
      data-icon="exit"
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}
