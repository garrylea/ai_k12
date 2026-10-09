import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/base';
import { requestPasswordReset, resetPassword } from '@/services/api';

/**
 * 忘记密码（家长自助，模拟验证码直显；spec: 2026-10-09-forgot-password-design.md）。
 *
 * 状态机（单页表单）：
 * - idle：可输入手机号；「获取验证码」仅在手机号匹配 ^1\d{10}$ 时可点
 * - codeIssued：验证码直显（模拟验证码，spec 裁决）+ 60s 倒计时禁用重发
 * - 任何一步失败：error 区展示后端 message（如「该手机号未注册」「验证码已过期」）
 * - resetSuccess：提示「密码重置成功」→ 1.2s 后自动跳回 /login
 * 学生按 UX 口径不做自助找回（顶部说明文案）。
 */
export default function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayedCode, setDisplayedCode] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const navigateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (navigateTimerRef.current) clearTimeout(navigateTimerRef.current);
    };
  }, []);

  const phoneValid = /^1\d{10}$/.test(phone);

  const handleRequestCode = async () => {
    if (!phoneValid) {
      setError('请输入 11 位手机号');
      return;
    }
    setRequesting(true);
    setError('');
    try {
      const result = await requestPasswordReset(phone);
      setDisplayedCode(result.code);
      setCountdown(60);
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        setCountdown((n) => {
          if (n <= 1 && timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
            return 0;
          }
          return n - 1;
        });
      }, 1000);
    } catch (err: unknown) {
      setError(err instanceof Error ? (err.message || '获取验证码失败，请重试') : '获取验证码失败，请重试');
    } finally {
      setRequesting(false);
    }
  };

  const handleReset = async () => {
    if (!phoneValid) {
      setError('请输入 11 位手机号');
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      setError('请输入 6 位数字验证码');
      return;
    }
    if (newPassword.length < 6 || newPassword.length > 32) {
      setError('密码长度需为 6-32 位');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }
    setResetting(true);
    setError('');
    try {
      await resetPassword(phone, code, newPassword);
      // spec §2.1：先提示成功，1.2s 后自动回登录页
      setSuccess(true);
      navigateTimerRef.current = setTimeout(() => navigate('/login'), 1200);
    } catch (err: unknown) {
      setError(err instanceof Error ? (err.message || '重置失败，请重试') : '重置失败，请重试');
    } finally {
      setResetting(false);
    }
  };

  return (
    <div
      data-theme="parent"
      className="min-h-screen flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--bg-page)' }}
    >
      <div className="w-full max-w-md">
        <div
          className="rounded-[var(--radius-card)] overflow-hidden"
          style={{
            backgroundColor: 'var(--bg-card)',
            boxShadow: 'var(--shadow-card-strong)',
          }}
        >
          {/* 上半部：标题区（与注册页同构：家长蓝白主题） */}
          <div className="px-10 pt-8 pb-6 text-center space-y-3">
            <h1 className="text-[1.75rem] font-bold tracking-wide" style={{ color: 'var(--brand-500)' }}>
              忘记密码
            </h1>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              本流程用于家长账号；学生密码请联系家长在家长端重置
            </p>
          </div>

          <form
            className="bg-white px-10 pt-7 pb-8 space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              handleReset();
            }}
          >
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="fp-phone"
                  className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5"
                >
                  手机号
                </label>
                <div className="flex gap-2">
                  <input
                    id="fp-phone"
                    type="tel"
                    placeholder="请输入家长手机号"
                    value={phone}
                    maxLength={11}
                    onChange={(e) => {
                      setPhone(e.target.value);
                      setError('');
                    }}
                    className="w-full px-4 py-3 rounded-[var(--radius-input)] bg-[var(--bg-form)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30"
                  />
                  <Button
                    type="button"
                    variant="primary"
                    onClick={handleRequestCode}
                    disabled={!phoneValid || requesting || countdown > 0}
                    className="shrink-0 whitespace-nowrap !bg-[var(--brand-500)] !text-white hover:!bg-[var(--brand-400)] active:!bg-[var(--brand-600)]"
                  >
                    {countdown > 0 ? `${countdown} 秒后可重发` : requesting ? '获取中…' : '获取验证码'}
                  </Button>
                </div>
              </div>

              {displayedCode && (
                <div
                  data-testid="displayed-code"
                  className="text-sm px-3 py-2 rounded-[var(--radius-input)]"
                  style={{ backgroundColor: 'var(--bg-form)', color: 'var(--text-primary)' }}
                >
                  模拟验证码：<span className="font-bold tracking-widest">{displayedCode}</span>
                  （5 分钟内有效；接入短信服务前临时展示于此）
                </div>
              )}

              <div>
                <label
                  htmlFor="fp-code"
                  className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5"
                >
                  验证码
                </label>
                <input
                  id="fp-code"
                  type="text"
                  inputMode="numeric"
                  placeholder="6 位数字"
                  value={code}
                  maxLength={6}
                  onChange={(e) => {
                    setCode(e.target.value);
                    setError('');
                  }}
                  className="w-full px-4 py-3 rounded-[var(--radius-input)] bg-[var(--bg-form)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30"
                />
              </div>

              <div>
                <label
                  htmlFor="fp-new-password"
                  className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5"
                >
                  新密码
                </label>
                <input
                  id="fp-new-password"
                  type="password"
                  placeholder="6-32 位"
                  value={newPassword}
                  maxLength={32}
                  onChange={(e) => {
                    setNewPassword(e.target.value);
                    setError('');
                  }}
                  className="w-full px-4 py-3 rounded-[var(--radius-input)] bg-[var(--bg-form)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30"
                />
              </div>

              <div>
                <label
                  htmlFor="fp-confirm-password"
                  className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5"
                >
                  确认新密码
                </label>
                <input
                  id="fp-confirm-password"
                  type="password"
                  placeholder="再次输入新密码"
                  value={confirmPassword}
                  maxLength={32}
                  onChange={(e) => {
                    setConfirmPassword(e.target.value);
                    setError('');
                  }}
                  className="w-full px-4 py-3 rounded-[var(--radius-input)] bg-[var(--bg-form)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30"
                />
                {error && (
                  <div className="mt-2 text-sm text-[var(--error)] bg-[var(--error)]/10 px-3 py-1.5 rounded-[var(--radius-input)]">
                    {error}
                  </div>
                )}
                {success && (
                  <div
                    className="mt-2 text-sm px-3 py-1.5 rounded-[var(--radius-input)]"
                    style={{ backgroundColor: 'var(--bg-form)', color: 'var(--text-primary)' }}
                  >
                    密码重置成功，正在返回登录页…
                  </div>
                )}
              </div>
            </div>

            <Button
              variant="primary"
              size="lg"
              type="submit"
              className="w-full !bg-[var(--brand-500)] !text-white hover:!bg-[var(--brand-400)] active:!bg-[var(--brand-600)]"
              disabled={resetting || success}
            >
              {resetting ? '重置中…' : '重置密码'}
            </Button>

            <p className="text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
              想起密码了？{' '}
              <Link to="/login" className="font-semibold hover:underline" style={{ color: 'var(--brand-500)' }}>
                返回登录
              </Link>
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
