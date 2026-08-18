import { useEffect, useState } from 'react';
import { Input, ConfirmDialog, toast } from '@/components/base';
import {
  searchParents,
  searchStudents,
  setParentStatus,
  setStudentStatusAdmin,
  type AdminParentItem,
  type AdminStudentItem,
} from '@/services/api';

type Tab = 'parents' | 'students';

/** 打码手机号：前 3 位 + **** + 后 4 位。 */
const maskPhone = (phone: string) =>
  phone.length >= 11 ? `${phone.slice(0, 3)}****${phone.slice(7)}` : phone;

const tabBase =
  'px-5 h-10 rounded-lg text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--brand-100)]';
const tabActive = 'bg-[var(--brand-500)] text-white shadow-sm';
const tabInactive =
  'bg-white border border-gray-200 text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]';

export default function AdminAccountsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('parents');
  const [search, setSearch] = useState('');
  const [parents, setParents] = useState<AdminParentItem[]>([]);
  const [students, setStudents] = useState<AdminStudentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [banTarget, setBanTarget] = useState<AdminParentItem | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  // debounce 300ms 拉取当前 Tab 列表；依赖变化/卸载时清理定时器并忽略迟到响应。
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      setLoading(true);
      (async () => {
        try {
          const q = search.trim();
          if (activeTab === 'parents') {
            const list = await searchParents(q);
            if (!cancelled) setParents(list);
          } else {
            const list = await searchStudents(q);
            if (!cancelled) setStudents(list);
          }
        } catch (err: unknown) {
          if (!cancelled) toast('error', err instanceof Error ? err.message : '加载失败');
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [activeTab, search, refreshTick]);

  const reload = () => setRefreshTick((t) => t + 1);

  const handleBanParent = async () => {
    if (!banTarget) return;
    const p = banTarget;
    setBanTarget(null);
    try {
      await setParentStatus(p.id, false);
      toast('success', '已封禁，其名下学生同步停用');
      reload();
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : '操作失败');
    }
  };

  const handleUnbanParent = async (p: AdminParentItem) => {
    try {
      await setParentStatus(p.id, true);
      toast('success', '已解封');
      reload();
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : '操作失败');
    }
  };

  const handleToggleStudent = async (s: AdminStudentItem) => {
    try {
      await setStudentStatusAdmin(s.id, !s.isActive);
      toast('success', s.isActive ? `已封禁 ${s.username}` : `已解封 ${s.username}`);
      reload();
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : '操作失败');
    }
  };

  const statusBadge = (isActive: boolean) => (
    <span
      className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded"
      style={{
        color: isActive ? '#059669' : 'var(--text-secondary)',
        backgroundColor: isActive ? 'rgba(5,150,105,0.08)' : 'rgba(0,0,0,0.04)',
      }}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${isActive ? 'bg-[#059669]' : 'bg-[var(--text-secondary)]'}`} />
      {isActive ? '正常' : '停用'}
    </span>
  );

  const emptyRow = (colSpan: number) => (
    <tr>
      <td colSpan={colSpan} className="px-5 py-10 text-center text-sm text-[var(--text-secondary)]">
        {loading ? '加载中...' : '未找到匹配账号'}
      </td>
    </tr>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-black tracking-tight" style={{ color: 'var(--text-primary)' }}>
          账号管理
        </h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          搜索并管理家长与学生账号，可封禁/解封账号控制登录权限。
        </p>
      </div>

      {/* Tab 切换 + 搜索 */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex gap-2">
          <button
            type="button"
            className={`${tabBase} ${activeTab === 'parents' ? tabActive : tabInactive}`}
            onClick={() => setActiveTab('parents')}
          >
            家长
          </button>
          <button
            type="button"
            className={`${tabBase} ${activeTab === 'students' ? tabActive : tabInactive}`}
            onClick={() => setActiveTab('students')}
          >
            学生
          </button>
        </div>
        <div className="w-full max-w-xs">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={activeTab === 'parents' ? '搜索手机号 / 姓名' : '搜索用户名 / 姓名'}
          />
        </div>
      </div>

      {/* 家长列表 */}
      {activeTab === 'parents' ? (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-[var(--text-secondary)] border-b border-gray-100">
                  <th className="px-5 py-3 font-semibold">手机号</th>
                  <th className="px-5 py-3 font-semibold">姓名</th>
                  <th className="px-5 py-3 font-semibold">名下学生</th>
                  <th className="px-5 py-3 font-semibold">状态</th>
                  <th className="px-5 py-3 font-semibold text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {parents.map((p) => (
                  <tr key={p.id} className="border-b border-gray-50 last:border-0">
                    <td className="px-5 py-3" style={{ color: 'var(--text-primary)' }}>{maskPhone(p.phone)}</td>
                    <td className="px-5 py-3">{p.name ?? '-'}</td>
                    <td className="px-5 py-3">{p.studentCount}</td>
                    <td className="px-5 py-3">{statusBadge(p.isActive)}</td>
                    <td className="px-5 py-3">
                      <div className="flex justify-end text-xs font-semibold whitespace-nowrap">
                        {p.isActive ? (
                          <button
                            className="text-[var(--error)] hover:underline"
                            onClick={() => setBanTarget(p)}
                          >
                            封禁
                          </button>
                        ) : (
                          <button
                            className="text-[var(--brand-500)] hover:underline"
                            onClick={() => handleUnbanParent(p)}
                          >
                            解封
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {parents.length === 0 && emptyRow(5)}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        /* 学生列表 */
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-[var(--text-secondary)] border-b border-gray-100">
                  <th className="px-5 py-3 font-semibold">用户名</th>
                  <th className="px-5 py-3 font-semibold">姓名</th>
                  <th className="px-5 py-3 font-semibold">年级</th>
                  <th className="px-5 py-3 font-semibold">状态</th>
                  <th className="px-5 py-3 font-semibold text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {students.map((s) => (
                  <tr key={s.id} className="border-b border-gray-50 last:border-0">
                    <td className="px-5 py-3" style={{ color: 'var(--text-primary)' }}>{s.username}</td>
                    <td className="px-5 py-3">{s.name}</td>
                    <td className="px-5 py-3">{s.grade ?? '-'}</td>
                    <td className="px-5 py-3">{statusBadge(s.isActive)}</td>
                    <td className="px-5 py-3">
                      <div className="flex justify-end text-xs font-semibold whitespace-nowrap">
                        {s.isActive ? (
                          <button
                            className="text-[var(--error)] hover:underline"
                            onClick={() => handleToggleStudent(s)}
                          >
                            封禁
                          </button>
                        ) : (
                          <button
                            className="text-[var(--brand-500)] hover:underline"
                            onClick={() => handleToggleStudent(s)}
                          >
                            解封
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {students.length === 0 && emptyRow(5)}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 封禁家长确认（连带停用其名下学生） */}
      <ConfirmDialog
        open={banTarget !== null}
        title="提示："
        message={
          banTarget
            ? `将连带停用其名下 ${banTarget.studentCount} 个学生账号，确认封禁该家长？`
            : ''
        }
        onConfirm={handleBanParent}
        onCancel={() => setBanTarget(null)}
      />
    </div>
  );
}
