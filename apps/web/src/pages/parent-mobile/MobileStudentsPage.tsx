import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ConfirmDialog } from '@/components/base';
import { createStudent, listMyStudents, resetStudentPassword, setStudentStatus, type MyStudentItem } from '@/services/api';

type LoadStatus = 'loading' | 'ready' | 'error';

const GRADES = [
  '小学一年级', '小学二年级', '小学三年级', '小学四年级', '小学五年级', '小学六年级',
  '初一', '初二', '初三', '高一', '高二', '高三',
];
const emptyForm = { name: '', username: '', password: '', age: '', grade: '小学一年级' };

export default function MobileStudentsPage() {
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [students, setStudents] = useState<MyStudentItem[] | null>(null);
  const [error, setError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [resetId, setResetId] = useState<number | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  // 停用需确认弹窗（spec §4.2）；启用是恢复性操作，直接执行不弹窗
  const [disableTarget, setDisableTarget] = useState<MyStudentItem | null>(null);

  const load = useCallback(() => {
    setError(false);
    listMyStudents()
      .then((list) => { setStudents(list); setStatus('ready'); })
      .catch(() => setError(true));
  }, []);
  useEffect(() => { load(); }, [load]);

  const submitCreate = () => {
    const age = Number(form.age);
    if (!form.name.trim() || !form.username.trim() || form.password.length < 6 || !Number.isInteger(age) || age <= 0 || !form.grade) {
      setFormError('请填齐全部字段；密码至少 6 位；年龄须为正整数');
      return;
    }
    setFormError(null);
    createStudent({ name: form.name.trim(), username: form.username.trim(), password: form.password, age, grade: form.grade })
      .then(() => {
        setActionMsg(`学生账号 ${form.name.trim()} 已开通`);
        setForm(emptyForm);
        setCreating(false);
        load();
      })
      .catch((e: unknown) => setFormError(e instanceof Error ? e.message : '开通失败'));
  };

  const submitReset = () => {
    if (resetId === null) return;
    if (newPassword.length < 6 || newPassword.length > 32) {
      setActionMsg('新密码需 6-32 位');
      return;
    }
    const target = students?.find((s) => s.id === resetId);
    resetStudentPassword(resetId, newPassword)
      .then(() => { setActionMsg(`已重置 ${target?.name ?? '学生'} 的密码：${newPassword}`); setResetId(null); setNewPassword(''); })
      .catch((e: unknown) => setActionMsg(e instanceof Error ? e.message : '操作失败'));
  };

  const applyStatus = (s: MyStudentItem) => {
    setStudentStatus(s.id, !s.isActive)
      .then(() => setStudents((prev) => prev?.map((x) => (x.id === s.id ? { ...x, isActive: !x.isActive } : x)) ?? prev))
      .then(() => setActionMsg(s.isActive ? `已停用 ${s.name} 的账号` : `已启用 ${s.name} 的账号`))
      .catch((e: unknown) => setActionMsg(e instanceof Error ? e.message : '操作失败'));
  };

  const toggleStatus = (s: MyStudentItem) => {
    if (s.isActive) {
      setDisableTarget(s);
      return;
    }
    applyStatus(s);
  };

  return (
    <div data-testid="mobile-page-students" className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--text-tertiary)]">为每个孩子开通独立学习账号</p>
        <button data-testid="student-create-toggle" onClick={() => { setCreating((v) => !v); setFormError(null); }} className="rounded-xl bg-[var(--brand-500)] px-3 py-1.5 text-sm text-white">
          {creating ? '收起' : '新建学生'}
        </button>
      </div>
      {creating && (
        <div className="space-y-2 rounded-2xl bg-white p-4">
          {[['姓名', 'name', 'text'], ['用户名', 'username', 'text'], ['初始密码', 'password', 'password']].map(([label, key, type]) => (
            <div key={key}>
              <label className="text-xs text-[var(--text-secondary)]">{label}</label>
              <input aria-label={label} type={type} value={form[key as keyof typeof form]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} className="mt-1 w-full rounded-xl border border-[var(--bg-subtle)] px-3 py-2 text-sm" />
            </div>
          ))}
          <div>
            <label className="text-xs text-[var(--text-secondary)]">年龄</label>
            <input aria-label="年龄" inputMode="numeric" value={form.age} onChange={(e) => setForm({ ...form, age: e.target.value })} className="mt-1 w-full rounded-xl border border-[var(--bg-subtle)] px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs text-[var(--text-secondary)]">年级</label>
            <select aria-label="年级" value={form.grade} onChange={(e) => setForm({ ...form, grade: e.target.value })} className="mt-1 w-full rounded-xl border border-[var(--bg-subtle)] px-3 py-2 text-sm">
              {GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>
          {formError && <p className="text-xs text-[var(--error)]">{formError}</p>}
          <button data-testid="student-create-submit" onClick={submitCreate} className="w-full rounded-xl bg-[var(--brand-500)] py-2 text-sm text-white">开通学生账号</button>
        </div>
      )}
      {error ? (
        <div className="rounded-2xl bg-white p-8 text-center">
          <p className="text-[var(--text-secondary)]">加载失败</p>
          <button data-testid="students-retry" onClick={load} className="mt-2 text-[var(--brand-500)]">重试</button>
        </div>
      ) : status === 'loading' || students === null ? (
        <div className="h-24 animate-pulse rounded-2xl bg-white" />
      ) : (
        <ul className="space-y-2">
          {students.map((s) => (
            <li key={s.id} className="rounded-2xl bg-white p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold">{s.name}</p>
                  <p className="text-xs text-[var(--text-tertiary)]">{s.grade ?? '年级未设'} · {s.age ?? '—'} 岁</p>
                </div>
                <span className="text-xs text-[var(--text-tertiary)]">{s.isActive ? '状态正常' : '已停用'}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                <Link to={`/m/parent/students/${s.id}/config`} className="rounded-lg border border-[var(--bg-subtle)] px-3 py-1.5">学习配置</Link>
                <button data-testid={`student-reset-toggle-${s.id}`} onClick={() => { setResetId(resetId === s.id ? null : s.id); setNewPassword(''); }} className="rounded-lg border border-[var(--bg-subtle)] px-3 py-1.5">重置密码</button>
                <button data-testid={`student-status-toggle-${s.id}`} onClick={() => toggleStatus(s)} className="rounded-lg border border-[var(--bg-subtle)] px-3 py-1.5">{s.isActive ? '停用账号' : '启用账号'}</button>
              </div>
              {resetId === s.id && (
                <div className="mt-2 flex gap-2">
                  <input placeholder="输入新密码（6-32 位）" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="min-w-0 flex-1 rounded-xl border border-[var(--bg-subtle)] px-3 py-2 text-sm" />
                  <button data-testid={`student-reset-submit-${s.id}`} onClick={submitReset} className="rounded-xl bg-[var(--brand-500)] px-3 py-2 text-sm text-white">确认</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {actionMsg && <p className="px-2 text-sm text-[var(--text-secondary)]">{actionMsg}</p>}
      {disableTarget && (
        <ConfirmDialog
          open={disableTarget !== null}
          title={`停用 ${disableTarget.name} 的账号`}
          message="停用后该学生将无法登录学习。确认停用？"
          onConfirm={() => { const t = disableTarget; setDisableTarget(null); if (t) applyStatus(t); }}
          onCancel={() => setDisableTarget(null)}
        />
      )}
    </div>
  );
}
