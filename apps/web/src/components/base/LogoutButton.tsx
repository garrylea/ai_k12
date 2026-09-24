import { ButtonHTMLAttributes, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { isCurrentStudentLocked } from '@/kiosk/learningLock';
import { releaseOnLogout } from '@/kiosk/desktopBridge';
import { toast } from './Toast';

interface LogoutButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Button label, used for title + aria-label. Default "退出登录" */
  label?: string;
  /** Extra cleanup before clearing auth (e.g. reset in-memory stores) */
  onLogout?: () => void;
  /** When provided, renders as a user-info pill (avatar + name + logout icon) instead of the icon-only circle. */
  username?: string;
  /** Avatar initial; falls back to username[0]. */
  initial?: string;
}

const LOCKED_HINT = '本次学习时长未满，需家长解除后才能退出';

const LogOutIcon = ({ className = 'w-5 h-5' }: { className?: string }) => (
  <svg
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

/**
 * 统一的退出登录控件：集中清理 localStorage 鉴权信息并跳转登录页。
 * 默认沿用与 BackButton 一致的圆形白底风格，可通过 `className` 覆盖。
 */
export function LogoutButton({
  label = '退出登录',
  onLogout,
  username,
  initial,
  className,
  ...rest
}: LogoutButtonProps) {
  const navigate = useNavigate();
  const [locked, setLocked] = useState(() => isCurrentStudentLocked());

  /**
   * 锁定态会随时间变化（到点自动解除），所以每秒对一次表——**只在锁定时起定时器**，
   * 平时零开销。不依赖 `LearningSessionShell` 的原因是：本组件也被家长/管理员页面使用，
   * 那些页面上那个壳根本不参与。
   */
  useEffect(() => {
    if (!locked) return;
    const timer = window.setInterval(() => setLocked(isCurrentStudentLocked()), 1000);
    return () => window.clearInterval(timer);
  }, [locked]);

  const handleLogout = () => {
    // 再判一次，不只是信 state：距上次 tick 最多差 1 秒，而这里才是**真正的闸门**。
    if (isCurrentStudentLocked()) {
      setLocked(true);
      toast('info', LOCKED_HINT);
      return;
    }
    releaseOnLogout();
    onLogout?.();
    localStorage.removeItem('token');
    localStorage.removeItem('userId');
    localStorage.removeItem('username');
    localStorage.removeItem('userRole');
    navigate('/login');
  };

  /**
   * 锁定中的公共属性。
   *
   * ⚠️ 三条**都不能改**：
   * 1. `aria-label` / `title` 仍是 `label`（='退出登录'）——4 个现有测试用
   *    `getByLabelText('退出登录')` 断言存在，改成提示文案会连带打破它们；提示走 toast。
   * 2. **不给原生 `disabled`**：原生禁用按钮不触发 click，toast 就永远弹不出来。
   *    真正的闸门是 `handleLogout` 里的判断，不是属性。
   * 3. `data-locked` 供测试与样式选择。
   */
  const lockProps = locked
    ? ({ 'aria-disabled': true, 'data-locked': 'true' } as const)
    : ({} as const);
  const lockClass = locked ? 'opacity-50 cursor-not-allowed' : undefined;

  // 用户信息药丸变体：头像 + 用户名 + 退出图标，整颗药丸即退出触发器。
  if (username) {
    const avatarText = initial ?? username.charAt(0);
    return (
      <button
        {...rest}
        {...lockProps}
        type="button"
        onClick={handleLogout}
        title={label}
        aria-label={label}
        className={clsx(
          'group flex items-center gap-2 bg-white px-3 py-1.5 rounded-full border border-slate-200 shadow-sm',
          'hover:bg-slate-50 hover:border-slate-300 transition-colors',
          lockClass,
          className,
        )}
      >
        <div className="w-6 h-6 rounded-full bg-[var(--brand-500)] text-white flex items-center justify-center text-xs font-bold">
          {avatarText}
        </div>
        <span className="text-sm font-medium text-[var(--text-primary)]">{username}</span>
        <LogOutIcon className="w-4 h-4 text-slate-400 group-hover:text-slate-600 transition-colors" />
      </button>
    );
  }

  // 默认：纯图标圆形按钮。
  return (
    <button
      {...rest}
      {...lockProps}
      type="button"
      onClick={handleLogout}
      title={label}
      aria-label={label}
      className={clsx(
        'p-2.5 rounded-full bg-white border border-slate-200 shadow-sm',
        'hover:bg-slate-50 transition-colors text-slate-600',
        lockClass,
        className,
      )}
    >
      <LogOutIcon />
    </button>
  );
}
