import { ButtonHTMLAttributes } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';

interface BackButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * Navigation target path.
   *
   * **故意可选**：不传时不是「写漏了」，而是切换到「返回上一页」模式 ——
   * 见组件文档注释的两种模式说明。全仓传 `to` 的调用点行为不变。
   */
  to?: string;
  /** Optional destination label, shown next to the icon + used for title / aria-label */
  label?: string;
  /** Optional navigation state (e.g. { subjectId })；仅在传了 `to` 时有意义 */
  state?: unknown;
}

const ArrowLeftIcon = () => (
  <svg
    className="w-5 h-5"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

/**
 * 统一的返回控件：圆形白底图标 + 可选文字（紧挨图标）。
 * 风格基准为知识星图（StarMapPage）的返回按钮。
 *
 * **两种模式**（`to` 是否传入决定，`to?: string` 是故意的，勿当成「漏传」补默认值）：
 *
 * 1. **跳到指定路径** —— 传 `to`。`onClick` 走 `navigate(to, …)`，
 *    `state` 只在此时有意义。默认可访问名为「返回」。
 *    例：`<BackButton to="/student/entry" />`、`<BackButton to="/student/star-map" state={{ subjectId }} />`。
 * 2. **返回上一页** —— 不传 `to`。`onClick` 走 `navigate(-1)`，回退一格路由历史；
 *    此时 `state` 无意义、被忽略。默认可访问名为「返回上一页」。
 *    例：`<BackButton />`（个人中心 / 奖励册这类「浅停留页」顶栏）。
 *
 * **不做「没有上一页时兜底跳某处」**：直接 `navigate(-1)`。
 * 判断「是否存在站内历史」在 `createMemoryRouter`（测试）下不可测、
 * 在 browser history 下又只对生产生效（`history.state.idx === 0` 这类探测），
 * 属过度设计；真正需要确定落点的场景就传 `to`（模式 1）。
 */
export function BackButton({ to, label, state, className, ...rest }: BackButtonProps) {
  const navigate = useNavigate();
  const accessibleLabel = label || (to === undefined ? '返回上一页' : '返回');
  return (
    <button
      {...rest}
      type="button"
      onClick={() => {
        if (to === undefined) {
          navigate(-1);
          return;
        }
        navigate(to, state !== undefined ? { state } : undefined);
      }}
      title={accessibleLabel}
      aria-label={accessibleLabel}
      className={clsx('inline-flex items-center gap-1.5 text-slate-600', className)}
    >
      <span
        className={clsx(
          'inline-flex items-center justify-center p-2.5 rounded-full',
          'bg-white border border-slate-200 shadow-sm',
          'hover:bg-slate-50 transition-colors',
        )}
      >
        <ArrowLeftIcon />
      </span>
      {label ? <div className="text-sm font-medium">{label}</div> : null}
    </button>
  );
}
