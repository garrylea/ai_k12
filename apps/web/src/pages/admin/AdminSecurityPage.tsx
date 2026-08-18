import { useState } from 'react';
import { Button, Input, toast } from '@/components/base';
import { changeAdminPassword } from '@/services/api';

export default function AdminSecurityPage() {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!oldPassword || !newPassword) {
      toast('error', '请填写旧密码与新密码');
      return;
    }
    if (newPassword.length < 6 || newPassword.length > 32) {
      toast('error', '新密码需为 6-32 位');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast('error', '两次输入的新密码不一致');
      return;
    }
    setSubmitting(true);
    try {
      await changeAdminPassword(oldPassword, newPassword);
      toast('success', '密码已修改');
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : '修改失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-black tracking-tight" style={{ color: 'var(--text-primary)' }}>账号安全</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>修改管理员登录密码</p>
      </div>

      <div className="max-w-md">
        <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-5">
          <h2 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>修改密码</h2>
          <Input
            label="旧密码"
            type="password"
            value={oldPassword}
            onChange={(e) => setOldPassword(e.target.value)}
            placeholder="输入当前密码"
            autoComplete="current-password"
          />
          <Input
            label="新密码"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="6-32 位新密码"
            autoComplete="new-password"
          />
          <Input
            label="确认新密码"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="再次输入新密码"
            autoComplete="new-password"
          />
          <div className="flex justify-end pt-1">
            <Button variant="primary" size="md" loading={submitting} onClick={handleSubmit}>确认修改</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
