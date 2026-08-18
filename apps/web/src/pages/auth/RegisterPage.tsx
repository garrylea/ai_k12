import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/base';
import { registerParent } from '@/services/api';

export default function RegisterPage() {
  const navigate = useNavigate();
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleRegister = async () => {
    if (!/^1\d{10}$/.test(phone)) {
      setError('请输入 11 位手机号');
      return;
    }
    if (password.length < 6 || password.length > 32) {
      setError('密码长度需为 6-32 位');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await registerParent(phone, password, name || undefined);
      localStorage.setItem('token', result.token);
      localStorage.setItem('username', result.user.phone ?? phone);
      localStorage.setItem('userId', String(result.user.id));
      localStorage.setItem('userRole', result.user.role);
      navigate('/parent/students');
    } catch (err: unknown) {
      setError(err instanceof Error ? (err.message || '注册失败，请重试') : '注册失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      data-theme="parent"
      className="min-h-screen flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--bg-page)' }}
    >
      <div className="w-full max-w-md">
        {/* 注册卡片：上蓝色标题区 + 下白色表单区（家长蓝白主题） */}
        <div
          className="rounded-[var(--radius-card)] overflow-hidden"
          style={{
            backgroundColor: 'var(--bg-card)',
            boxShadow: 'var(--shadow-card-strong)',
          }}
        >
          {/* 上半部：品牌区 */}
          <div className="px-10 pt-8 pb-6 text-center space-y-3">
            <h1 className="text-[1.75rem] font-bold tracking-wide" style={{ color: 'var(--brand-500)' }}>
              注册家长账号
            </h1>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              注册后可为孩子开通独立学习账号
            </p>
          </div>

          {/* 下半部：表单区 */}
          <div className="bg-white px-10 pt-7 pb-8 space-y-5">
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="phone"
                  className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5"
                >
                  手机号
                </label>
                <input
                  id="phone"
                  type="tel"
                  placeholder="请输入手机号"
                  value={phone}
                  maxLength={11}
                  onChange={(e) => {
                    setPhone(e.target.value);
                    setError('');
                  }}
                  className="w-full px-4 py-3 rounded-[var(--radius-input)] bg-[var(--bg-form)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30"
                />
              </div>

              <div>
                <label
                  htmlFor="name"
                  className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5"
                >
                  姓名（可选）
                </label>
                <input
                  id="name"
                  type="text"
                  placeholder="如何称呼您"
                  value={name}
                  maxLength={50}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-4 py-3 rounded-[var(--radius-input)] bg-[var(--bg-form)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30"
                />
              </div>

              <div>
                <label
                  htmlFor="reg-password"
                  className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5"
                >
                  设置密码
                </label>
                <input
                  id="reg-password"
                  type="password"
                  placeholder="6-32 位"
                  value={password}
                  maxLength={32}
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

            <Button
              variant="primary"
              size="lg"
              className="w-full !bg-[var(--brand-500)] !text-white hover:!bg-[var(--brand-400)] active:!bg-[var(--brand-600)]"
              onClick={handleRegister}
              disabled={loading}
            >
              {loading ? '注册中…' : '完成注册'}
            </Button>

            <p className="text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
              已有账号？{' '}
              <Link to="/login" className="font-semibold hover:underline" style={{ color: 'var(--brand-500)' }}>
                返回登录
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
