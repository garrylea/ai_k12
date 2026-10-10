import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/base';
import { login } from '@/services/api';
import { saveAuthSession } from '@/services/authStorage';
import { isDesktopShell } from '@/kiosk/desktopBridge';
import { MOBILE_VIEWPORT_BREAKPOINT } from '@/constants';

export default function LoginPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // 单点登录互踢（2026-10-10）：fetchApi 收到 1013 会清登录态并跳 /login?kicked=1，
  // 借既有 error 红字块展示被踢提示；用户开始输入后照常被 setError('') 清掉。
  const [error, setError] = useState(
    new URLSearchParams(window.location.search).get('kicked') === '1'
      ? '账号已在其他设备登录，请重新登录'
      : '',
  );
  const [loading, setLoading] = useState(false);
  // Web 端默认不勾（会话级登录）；PC App（Electron）默认勾选，保持关 App 重开仍登录的旧行为
  const [remember, setRemember] = useState(() => isDesktopShell());

  const handleLogin = async () => {
    if (!username || !password) {
      setError('请输入用户名和密码');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await login(username, password);
      // 「记住我」勾选 → localStorage（随服务端 7 天 JWT 持久化）；不勾 → sessionStorage（关浏览器即清）
      saveAuthSession(
        {
          token: result.token,
          // 家长无 username，存手机号供家长台头部展示（maskPhone 打码）
          username: result.user.username ?? result.user.phone ?? '',
          userId: String(result.user.id),
          userRole: result.user.role,
        },
        remember,
      );

      if (result.user.role === 'admin') {
        navigate('/admin');
      } else if (result.user.role === 'parent') {
        // 家长落点按视口分流：<768px 走移动路由组 /m/parent，否则桌面家长台
        navigate(window.innerWidth < MOBILE_VIEWPORT_BREAKPOINT ? '/m/parent' : '/parent/students');
      } else {
        navigate('/student/entry');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? (err.message || '登录失败，请重试') : '登录失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      data-theme="student-day"
      className="min-h-screen flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--bg-page)' }}
    >
      <div className="w-full max-w-md">
        {/* 登录卡片：上橘红标题区 + 下白色表单区 */}
        <div
          className="rounded-[var(--radius-card)] overflow-hidden"
          style={{
            backgroundColor: 'var(--bg-card)',
            boxShadow: 'var(--shadow-card-strong)',
          }}
        >
          {/* 上半部：品牌区 */}
          <div
            className="px-10 pt-8 pb-6 text-center space-y-4"
            style={{ backgroundColor: 'var(--brand-500)' }}
          >
            {/* 顶部图标 */}
            <div className="flex justify-center">
              <div
                className="w-20 h-20 rounded-[var(--radius-card)] flex items-center justify-center border-2 border-white/30 bg-white/10"
                aria-hidden="true"
              >
                <svg
                  className="w-10 h-10"
                  viewBox="0 0 48 48"
                  fill="none"
                  stroke="white"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M24 6L42 16v16L24 42L6 32V16L24 6z" />
                  <path d="M24 6v18" />
                  <path d="M24 24l18 8" />
                  <path d="M24 24L6 32" />
                </svg>
              </div>
            </div>

            {/* 标题 */}
            <div>
              <h1 className="text-[2rem] font-bold text-white tracking-wide">
                智学系统
              </h1>
              <p className="text-white/80 text-sm mt-1">
                陪伴您成长的每一步
              </p>
            </div>
          </div>

          {/* 下半部：表单区。用 <form> 包住输入与按钮，回车即可触发登录 */}
          <form
            className="bg-white px-10 pt-7 pb-8 space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              handleLogin();
            }}
          >
            {/* 输入框 */}
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="username"
                  className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5"
                >
                  账号
                </label>
                <input
                  id="username"
                  type="text"
                  placeholder="手机号（家长）/ 用户名（学生）"
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value);
                    setError('');
                  }}
                  className="w-full px-4 py-3 rounded-[var(--radius-input)] bg-[var(--bg-form)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30"
                />
              </div>

              <div>
                <label
                  htmlFor="password"
                  className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5"
                >
                  密码
                </label>
                <input
                  id="password"
                  type="password"
                  placeholder="请输入密码"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError('');
                  }}
                  className="w-full px-4 py-3 rounded-[var(--radius-input)] bg-[var(--bg-form)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30"
                />
                {error && (
                  <div className="mt-2 text-sm text-[var(--error)] bg-[var(--error)]/10 px-3 py-1.5 rounded-[var(--radius-input)]">
                    {error}
                  </div>
                )}
              </div>
            </div>

            {/* 记住我：Web 默认不勾、PC App 默认勾；不勾时登录态仅保留到浏览器关闭（sessionStorage） */}
            <div className="flex items-center gap-2">
              <input
                id="remember-me"
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="w-4 h-4 accent-[var(--brand-500)]"
              />
              <label htmlFor="remember-me" className="text-sm text-[var(--text-secondary)]">
                记住我
              </label>
            </div>

            {/* 登录按钮：橘红底，白字。type=submit 由 form onSubmit 触发（回车同样生效） */}
            <Button
              variant="primary"
              size="lg"
              type="submit"
              className="w-full !bg-[var(--brand-500)] !text-white hover:!bg-[var(--brand-400)] active:!bg-[var(--brand-600)]"
              disabled={loading}
            >
              {loading ? '登录中…' : '登录'}
            </Button>

            {/* 底部链接 */}
            <div className="flex items-center justify-between text-sm text-[var(--text-secondary)]">
              <Link to="/register" className="hover:text-[var(--brand-500)] hover:underline">
                注册家长账号
              </Link>
              <Link to="/forgot-password" className="hover:text-[var(--brand-500)] hover:underline">
                忘记密码？
              </Link>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
