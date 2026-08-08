import { ButtonHTMLAttributes } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';

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
  const handleLogout = () => {
    onLogout?.();
    localStorage.removeItem('token');
    localStorage.removeItem('userId');
    localStorage.removeItem('username');
    localStorage.removeItem('userRole');
    navigate('/login');
  };

  // 用户信息药丸变体：头像 + 用户名 + 退出图标，整颗药丸即退出触发器。
  if (username) {
    const avatarText = initial ?? username.charAt(0);
    return (
      <button
        {...rest}
        type="button"
        onClick={handleLogout}
        title={label}
        aria-label={label}
        className={clsx(
          'group flex items-center gap-2 bg-white px-3 py-1.5 rounded-full border border-slate-200 shadow-sm',
          'hover:bg-slate-50 hover:border-slate-300 transition-colors',
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
      type="button"
      onClick={handleLogout}
      title={label}
      aria-label={label}
      className={clsx(
        'p-2.5 rounded-full bg-white border border-slate-200 shadow-sm',
        'hover:bg-slate-50 transition-colors text-slate-600',
        className,
      )}
    >
      <LogOutIcon />
    </button>
  );
}
