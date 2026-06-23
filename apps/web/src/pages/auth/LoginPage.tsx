import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/base';

export default function LoginPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleLogin = () => {
    if (!username || !password) {
      setError('请输入用户名和密码');
      return;
    }
    const isPhone = /^1\d{10}$/.test(username);
    if (isPhone) {
      navigate('/parent/dashboard');
    } else {
      navigate('/student/subjects');
    }
  };

  return (
    <div
      data-theme="student-day"
      className="min-h-screen flex items-center justify-center p-4"
      style={{ backgroundColor: '#FAFAFA' }}
    >
      <div className="w-full max-w-md">
        {/* 登录卡片：上橘红标题区 + 下白色表单区 */}
        <div
          className="rounded-[var(--radius-card)] overflow-hidden"
          style={{
            backgroundColor: '#ffffff',
            boxShadow:
              '0 28px 70px rgba(0, 0, 0, 0.08), 0 10px 30px rgba(0, 0, 0, 0.04), 0 2px 8px rgba(0, 0, 0, 0.02)',
          }}
        >
          {/* 上半部：品牌区 */}
          <div
            className="px-10 pt-8 pb-6 text-center space-y-4"
            style={{ backgroundColor: '#ff6b35' }}
          >
            {/* 顶部图标 */}
            <div className="flex justify-center">
              <div
                className="w-20 h-20 rounded-[var(--radius-card)] flex items-center justify-center border-2 border-white/30 bg-white/10"
                aria-hidden="true"
              >
                <svg
                  width="40"
                  height="40"
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
              <h1 className="text-[32px] font-bold text-white tracking-wide">
                智学系统
              </h1>
              <p className="text-white/80 text-sm mt-1">
                陪伴您成长的每一步
              </p>
            </div>
          </div>

          {/* 下半部：表单区 */}
          <div className="bg-white px-10 pt-7 pb-8 space-y-5">
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
                  className="w-full px-4 py-3 rounded-[var(--radius-input)] bg-[#FAFAFA] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] outline-none focus:ring-2 focus:ring-[#ff6b35]/30"
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
                  className="w-full px-4 py-3 rounded-[var(--radius-input)] bg-[#FAFAFA] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] outline-none focus:ring-2 focus:ring-[#ff6b35]/30"
                />
                {error && (
                  <div className="mt-2 text-sm text-[var(--error)] bg-[var(--error)]/10 px-3 py-1.5 rounded-[var(--radius-input)]">
                    {error}
                  </div>
                )}
              </div>
            </div>

            {/* 登录按钮：橘红底，白字 */}
            <Button
              variant="primary"
              size="lg"
              className="w-full !bg-[#ff6b35] !text-white hover:!bg-[#ff5722] active:!bg-[#e64a19]"
              onClick={handleLogin}
            >
              登录
            </Button>

            {/* 底部链接 */}
            <div className="flex items-center justify-between text-sm text-[var(--text-secondary)]">
              <button className="hover:text-[#ff6b35] hover:underline">
                注册
              </button>
              <button className="hover:text-[#ff6b35] hover:underline">
                忘记密码？
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
