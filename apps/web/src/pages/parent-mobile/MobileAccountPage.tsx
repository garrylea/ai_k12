import { useCallback, useEffect, useState } from 'react';
import { toast } from '@/components/base';
import { ApiError, changeParentPassword, getParentAccount, type ParentAccount } from '@/services/api';

/**
 * /m/parent/account 移动端账号设置页（Task 6）。
 *
 * 两块：只读账号信息（手机号/姓名，name 可空 → 「未设置」）+ 修改密码
 * （旧密码/新密码/确认新密码；新密码过短或不一致为行内拦截，不发请求；
 * 后端 401/1003 旧密码错 → 旧密码框标错，其余错误文案原样展示）。
 *
 * `data-testid="mobile-page-account"` 被 Task 2 路由测试消费，参考 MobileControlsPage
 * 先例：testid 挂在**所有状态共用的外层容器**上，不只在数据就绪分支。
 *
 * 改密成功只 toast + 清空表单；按 API 口径改后不失效旧 token，本页不登出。
 */
type LoadStatus = 'loading' | 'ready' | 'error';

export default function MobileAccountPage() {
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [account, setAccount] = useState<ParentAccount | null>(null);
  const [error, setError] = useState(false);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [oldPasswordError, setOldPasswordError] = useState(false);

  const load = useCallback(() => {
    setError(false);
    getParentAccount()
      .then((a) => { setAccount(a); setStatus('ready'); })
      .catch(() => setError(true));
  }, []);
  useEffect(() => { load(); }, [load]);

  const submit = () => {
    setOldPasswordError(false);
    if (newPassword.length < 6) { setFormError('新密码至少 6 位'); return; }
    if (newPassword !== confirmPassword) { setFormError('两次输入的新密码不一致'); return; }
    setFormError(null);
    changeParentPassword(oldPassword, newPassword)
      .then(() => {
        toast('success', '密码已修改');
        setOldPassword(''); setNewPassword(''); setConfirmPassword('');
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : '修改失败';
        // 标错按 error code 判（后端 401/1003=旧密码错）：409/1001 文案「新密码不能与旧密码相同」
        // 含「旧密码」三字，按文案判会误标旧密码框。其余错误（含非 ApiError）只展示文案。
        if (e instanceof ApiError && e.code === 1003) setOldPasswordError(true);
        setFormError(msg);
      });
  };

  // 类型安全的字段描述（brief 稿里的混型元组改为对象数组，行为不变）
  const passwordFields: ReadonlyArray<{
    label: string;
    value: string;
    setter: (v: string) => void;
  }> = [
    { label: '旧密码', value: oldPassword, setter: setOldPassword },
    { label: '新密码', value: newPassword, setter: setNewPassword },
    { label: '确认新密码', value: confirmPassword, setter: setConfirmPassword },
  ];

  return (
    <div data-testid="mobile-page-account" className="space-y-3">
      {error ? (
        <div className="rounded-2xl bg-white p-8 text-center">
          <p className="text-[var(--text-secondary)]">加载失败</p>
          <button data-testid="account-retry" onClick={load} className="mt-2 text-[var(--brand-500)]">重试</button>
        </div>
      ) : status === 'loading' || account === null ? (
        <div className="h-24 animate-pulse rounded-2xl bg-white" />
      ) : (
        <>
          <div className="rounded-2xl bg-white p-4 text-sm">
            <p className="flex justify-between"><span className="text-[var(--text-secondary)]">手机号</span><span>{account.phone}</span></p>
            <p className="mt-2 flex justify-between"><span className="text-[var(--text-secondary)]">姓名</span><span>{account.name ?? '未设置'}</span></p>
          </div>
          <div className="space-y-2 rounded-2xl bg-white p-4">
            <p className="text-sm font-bold">修改密码</p>
            {passwordFields.map(({ label, value, setter }) => (
              <div key={label}>
                <label className="text-xs text-[var(--text-secondary)]">{label}</label>
                <input
                  aria-label={label}
                  type="password"
                  value={value}
                  onChange={(e) => setter(e.target.value)}
                  className={`mt-1 w-full rounded-xl border px-3 py-2 text-sm ${oldPasswordError && label === '旧密码' ? 'border-[var(--error)]' : 'border-[var(--bg-subtle)]'}`}
                />
              </div>
            ))}
            {formError && <p className="text-xs text-[var(--error)]">{formError}</p>}
            <button data-testid="account-password-submit" onClick={submit} className="w-full rounded-xl bg-[var(--brand-500)] py-2 text-sm text-white">保存新密码</button>
            <p className="text-xs text-[var(--text-tertiary)]">退出登录请使用顶栏的退出按钮。</p>
          </div>
        </>
      )}
    </div>
  );
}
