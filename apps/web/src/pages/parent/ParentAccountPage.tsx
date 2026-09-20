import { useEffect, useState } from 'react';
import { Button, Card, Input, LogoutButton, Skeleton, toast } from '@/components/base';
import { ApiError, changeParentPassword, getParentAccount, type ParentAccount } from '@/services/api';

/**
 * 账号设置 P6.10（spec §5.4 / plan Task 8）。
 *
 * 范围由用户 2026-09-20 裁决定死（spec §1.1 裁决 1）：**只有三件事** ——
 *   1. 账号信息**只读**（姓名 / 手机号）；
 *   2. 修改密码（旧 / 新 / 确认）；
 *   3. 退出登录（复用 `LogoutButton`，鉴权清理逻辑只有它一处）。
 *
 * **明确不做**（PRD 对 P6.10 几乎没约束，别自己发明）：改手机号、改姓名、
 * 订阅/订单/额度摘要（那些表根本不存在，spec §2.7）。
 *
 * 本页**账号级、不按学生**，故没有「派生状态带 studentId 归属」那套纪律 ——
 * 但也因此**不随顶栏切孩子变化**。
 */

const PASSWORD_MIN = 6;
const PASSWORD_MAX = 32;

interface FieldErrors {
  old?: string;
  next?: string;
  confirm?: string;
}

export default function ParentAccountPage() {
  const [account, setAccount] = useState<ParentAccount | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);

  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getParentAccount()
      .then((res) => {
        if (cancelled) return;
        setAccount(res);
        setFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        setAccount(null);
        setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  /** 本地校验：三条都过才发请求（避免无谓往返，也避免服务端 1001 的笼统文案）。 */
  const validate = (): FieldErrors => {
    const next: FieldErrors = {};
    if (!oldPassword) next.old = '请输入旧密码';
    if (newPassword.length < PASSWORD_MIN || newPassword.length > PASSWORD_MAX) {
      next.next = `新密码需为 ${PASSWORD_MIN}-${PASSWORD_MAX} 位`;
    }
    if (newPassword !== confirmPassword) next.confirm = '两次输入的新密码不一致';
    return next;
  };

  const clearDraft = () => {
    setOldPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setErrors({});
  };

  const handleSubmit = async () => {
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);
    try {
      await changeParentPassword(oldPassword, newPassword);
      toast('success', '密码已修改');
      clearDraft();
    } catch (err: unknown) {
      const message = err instanceof Error && err.message ? err.message : '修改失败';
      toast('error', message);
      /**
       * `1003` = 旧密码错（与登录失败同码）。把错误标在**旧密码框**上，家长才知道该改哪一格；
       * 其余失败（1001 长度/新旧相同、网络）只给 toast，不冤枉任何一格。
       */
      setErrors(err instanceof ApiError && err.code === 1003 ? { old: message } : {});
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <header className="mb-5">
        <h1 className="text-2xl font-black text-[var(--text-primary)]">账号设置</h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">查看家长账号信息并修改登录密码</p>
      </header>

      {failed ? (
        <Card
          data-testid="account-error"
          className="flex flex-wrap items-center justify-between gap-4 border border-[var(--error)] p-4"
        >
          <span className="text-sm text-[var(--text-secondary)]">账号信息暂时加载失败</span>
          <Button variant="secondary" size="sm" onClick={() => setReload((n) => n + 1)}>
            重试
          </Button>
        </Card>
      ) : account === null ? (
        <div data-testid="account-skeleton" className="space-y-3">
          <Skeleton width="100%" height={120} rounded />
          <Skeleton width="100%" height={280} rounded />
        </div>
      ) : (
        <>
          <Card data-testid="account-info" className="p-6">
            <h2 className="text-base font-bold text-[var(--text-primary)]">账号信息</h2>
            <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
              账号信息由注册时填写，如需修改请联系管理员。
            </p>

            <dl className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium text-[var(--text-secondary)]">姓名</dt>
                <dd
                  data-testid="account-name"
                  className="mt-1 text-sm text-[var(--text-primary)]"
                >
                  {account.name ?? '未设置'}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--text-secondary)]">手机号</dt>
                <dd
                  data-testid="account-phone"
                  className="mt-1 text-sm tabular-nums text-[var(--text-primary)]"
                >
                  {account.phone}
                </dd>
              </div>
            </dl>
          </Card>

          <Card data-testid="account-password" className="mt-4 p-6">
            <h2 className="text-base font-bold text-[var(--text-primary)]">修改密码</h2>
            <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
              修改后当前登录状态不会退出，下次登录请使用新密码。
            </p>

            <div className="mt-5 grid max-w-md grid-cols-1 gap-4">
              <Input
                label="旧密码"
                data-testid="old-password-input"
                type="password"
                value={oldPassword}
                disabled={submitting}
                autoComplete="current-password"
                placeholder="输入当前密码"
                error={errors.old}
                onChange={(e) => {
                  setOldPassword(e.target.value);
                  setErrors((prev) => ({ ...prev, old: undefined }));
                }}
              />
              <Input
                label="新密码"
                data-testid="new-password-input"
                type="password"
                value={newPassword}
                disabled={submitting}
                autoComplete="new-password"
                placeholder={`${PASSWORD_MIN}-${PASSWORD_MAX} 位新密码`}
                error={errors.next}
                onChange={(e) => {
                  setNewPassword(e.target.value);
                  setErrors((prev) => ({ ...prev, next: undefined }));
                }}
              />
              <Input
                label="确认新密码"
                data-testid="confirm-password-input"
                type="password"
                value={confirmPassword}
                disabled={submitting}
                autoComplete="new-password"
                placeholder="再次输入新密码"
                error={errors.confirm}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  setErrors((prev) => ({ ...prev, confirm: undefined }));
                }}
              />
            </div>

            <div className="mt-5 flex justify-end">
              <Button
                variant="primary"
                size="md"
                loading={submitting}
                data-testid="submit-password"
                onClick={() => void handleSubmit()}
              >
                确认修改
              </Button>
            </div>
          </Card>

          <Card data-testid="account-logout" className="mt-4 flex flex-wrap items-center justify-between gap-4 p-6">
            <div>
              <h2 className="text-base font-bold text-[var(--text-primary)]">退出登录</h2>
              <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
                退出后需要重新输入手机号与密码。
              </p>
            </div>
            <LogoutButton />
          </Card>
        </>
      )}
    </div>
  );
}
