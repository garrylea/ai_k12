import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Modal, toast } from '@/components/base';
import {
  listMyStudents,
  createStudent,
  resetStudentPassword,
  setStudentStatus,
  type MyStudentItem,
} from '@/services/api';

const GRADES = [
  '小学一年级', '小学二年级', '小学三年级', '小学四年级', '小学五年级', '小学六年级',
  '初一', '初二', '初三', '高一', '高二', '高三',
];

const emptyForm = { name: '', username: '', password: '', age: '', grade: '' };

export default function ParentStudentsPage() {
  const navigate = useNavigate();
  const [students, setStudents] = useState<MyStudentItem[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [resetTarget, setResetTarget] = useState<MyStudentItem | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setStudents(await listMyStudents());
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : '加载失败');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleCreate = async () => {
    setError('');
    if (!form.name || !form.username || !form.password || !form.age || !form.grade) {
      setError('请完整填写所有字段');
      return;
    }
    if (form.password.length < 6 || form.password.length > 32) {
      setError('初始密码长度需为 6-32 位');
      return;
    }
    setLoading(true);
    try {
      await createStudent({
        name: form.name,
        username: form.username,
        password: form.password,
        age: Number(form.age),
        grade: form.grade,
      });
      setShowCreate(false);
      setForm(emptyForm);
      toast('success', `学生账号 ${form.name} 已开通`);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '开通失败');
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async () => {
    if (!resetTarget) return;
    if (newPassword.length < 6 || newPassword.length > 32) {
      setError('密码长度需为 6-32 位');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await resetStudentPassword(resetTarget.id, newPassword);
      toast('success', `已重置 ${resetTarget.name} 的密码`);
      setResetTarget(null);
      setNewPassword('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '重置失败');
    } finally {
      setLoading(false);
    }
  };

  const handleToggleStatus = async (s: MyStudentItem) => {
    try {
      await setStudentStatus(s.id, !s.isActive);
      toast('success', s.isActive ? `已停用 ${s.name} 的账号` : `已启用 ${s.name} 的账号`);
      await load();
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : '操作失败');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black tracking-tight" style={{ color: 'var(--text-primary)' }}>
            学生账号管理
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
            为每个孩子开通独立学习账号，可重置密码或临时停用。
          </p>
        </div>
        {!showCreate && (
          <Button variant="primary" size="md" onClick={() => { setShowCreate(true); setError(''); }}>
            开通新账号
          </Button>
        )}
      </div>

      {showCreate && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-4">
          <h2 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>配置新的学生子账号</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>学生姓名</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="如：二宝"
                maxLength={50}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md focus:border-[var(--brand-500)] outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>登录用户名</label>
              <input
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                placeholder="字母或数字，如：erbao"
                maxLength={50}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md focus:border-[var(--brand-500)] outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>年龄</label>
              <input
                type="number"
                value={form.age}
                onChange={(e) => setForm({ ...form, age: e.target.value })}
                placeholder="如：13"
                min={3}
                max={18}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md focus:border-[var(--brand-500)] outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>年级</label>
              <select
                value={form.grade}
                onChange={(e) => setForm({ ...form, grade: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white focus:border-[var(--brand-500)] outline-none"
              >
                <option value="" disabled>请选择年级...</option>
                {GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>初始登录密码</label>
            <input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="6-32 位"
              maxLength={32}
              className="w-full max-w-md px-3 py-2 text-sm border border-gray-200 rounded-md focus:border-[var(--brand-500)] outline-none"
            />
          </div>
          {error && <p className="text-sm" style={{ color: 'var(--error)' }}>{error}</p>}
          <div className="flex gap-3 pt-2 border-t border-gray-100">
            <Button variant="primary" size="sm" loading={loading} onClick={handleCreate}>确认开通</Button>
            <Button variant="ghost" size="sm" onClick={() => { setShowCreate(false); setError(''); }}>取消</Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {students.map((s) => (
          <div key={s.id} className="bg-white rounded-2xl border border-gray-200 p-5">
            <div className="flex gap-3 items-center mb-4">
              <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center font-bold text-blue-600">
                {s.name.charAt(0)}
              </div>
              <div>
                <h3 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>{s.name}</h3>
                <span
                  className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded mt-1"
                  style={{
                    color: s.isActive ? '#059669' : 'var(--text-secondary)',
                    backgroundColor: s.isActive ? 'rgba(5,150,105,0.08)' : 'rgba(0,0,0,0.04)',
                  }}
                >
                  {s.isActive ? '状态正常' : '已停用'}
                </span>
              </div>
            </div>
            <div className="space-y-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
              <div className="flex justify-between border-b border-gray-50 pb-2">
                <span>登录账号</span>
                <span className="font-bold" style={{ color: 'var(--text-primary)' }}>{s.username}</span>
              </div>
              <div className="flex justify-between border-b border-gray-50 pb-2">
                <span>年龄/年级</span>
                <span>{s.age ? `${s.age}岁 / ` : ''}{s.grade ?? '-'}</span>
              </div>
            </div>
            <div className="flex flex-col gap-2 mt-5">
              <Button variant="secondary" size="sm" onClick={() => { setResetTarget(s); setNewPassword(''); setError(''); }}>
                重置密码
              </Button>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" className="flex-1" onClick={() => handleToggleStatus(s)}>
                  {s.isActive ? '停用账号' : '启用账号'}
                </Button>
                <Button variant="primary" size="sm" className="flex-1" onClick={() => navigate(`/parent/students/${s.id}/config`)}>
                  学习配置
                </Button>
              </div>
            </div>
          </div>
        ))}
        {students.length === 0 && !showCreate && (
          <div className="col-span-full bg-white rounded-2xl border border-dashed border-gray-200 p-10 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
            还没有为孩子开通账号，点击右上角「开通新账号」开始。
          </div>
        )}
      </div>

      <Modal
        open={resetTarget !== null}
        onClose={() => { setResetTarget(null); setError(''); }}
        title={`重置 ${resetTarget?.name ?? ''} 的密码`}
      >
        <div className="space-y-4">
          <input
            type="password"
            value={newPassword}
            onChange={(e) => { setNewPassword(e.target.value); setError(''); }}
            placeholder="输入新密码（6-32 位）"
            maxLength={32}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md focus:border-[var(--brand-500)] outline-none"
          />
          {error && <p className="text-sm" style={{ color: 'var(--error)' }}>{error}</p>}
          <div className="flex gap-3 justify-end">
            <Button variant="ghost" size="sm" onClick={() => { setResetTarget(null); setError(''); }}>取消</Button>
            <Button variant="primary" size="sm" loading={loading} onClick={handleReset}>确认重置</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
