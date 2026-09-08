import { useEffect, useState } from 'react';
import {
  fetchAdminDashboard,
  listAdminNotifications,
  markAdminNotificationRead,
  type AdminDashboard,
  type AdminNotificationItem,
} from '@/services/api';
import { Skeleton, toast } from '@/components/base';

export default function AdminDashboardPage() {
  const [data, setData] = useState<AdminDashboard | null>(null);
  const [error, setError] = useState('');
  // 解析失败通知（系统 -> 管理员）：列表 + 未读徽章 + 标已读
  const [notifications, setNotifications] = useState<AdminNotificationItem[] | null>(null);
  const [notifError, setNotifError] = useState(false);

  useEffect(() => {
    fetchAdminDashboard()
      .then(setData)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : '加载失败';
        setError(msg);
        toast('error', msg);
      });
  }, []);

  useEffect(() => {
    listAdminNotifications()
      .then(setNotifications)
      .catch(() => setNotifError(true));
  }, []);

  const unreadCount = (notifications ?? []).filter((n) => !n.isRead).length;

  const handleMarkRead = async (id: number) => {
    try {
      await markAdminNotificationRead(id);
      setNotifications((prev) => (prev ?? []).map((n) => (n.id === id ? { ...n, isRead: true } : n)));
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '操作失败');
    }
  };

  const maskPhone = (phone: string) => (phone.length >= 11 ? `${phone.slice(0, 3)}****${phone.slice(7)}` : phone);

  const stats = data
    ? [
        { label: '家长总数', value: data.parentCount, hint: '注册家长' },
        { label: '学生总数', value: data.studentCount, hint: '学习账号' },
        { label: '今日 AI 调用', value: data.todayAiCalls, hint: '对话新建数' },
        { label: '启用模型', value: data.enabledModelCount, hint: '模型池' },
      ]
    : [];

  if (!data && !error) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-black tracking-tight" style={{ color: 'var(--text-primary)' }}>总览</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>平台运行概况与最近注册家长</p>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="bg-white rounded-2xl border border-gray-200 p-5">
              <Skeleton width={64} height={12} />
              <Skeleton width={56} height={28} className="mt-4" />
            </div>
          ))}
        </div>
        <div className="bg-white rounded-2xl border border-gray-200 p-5 space-y-3">
          <Skeleton width={96} height={16} />
          <Skeleton width="100%" height={14} />
          <Skeleton width="100%" height={14} />
          <Skeleton width="75%" height={14} />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-black tracking-tight" style={{ color: 'var(--text-primary)' }}>总览</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>平台运行概况与最近注册家长</p>
        </div>
        <div className="bg-white rounded-2xl border border-dashed border-gray-200 p-10 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
          总览数据加载失败，请稍后重试
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-black tracking-tight" style={{ color: 'var(--text-primary)' }}>总览</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>平台运行概况与最近注册家长</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((s) => (
          <div key={s.label} className="bg-white rounded-2xl border border-gray-200 p-5 flex flex-col justify-between">
            <span className="text-sm text-[var(--text-secondary)]">{s.label}</span>
            <div className="flex items-end justify-between mt-3">
              <span className="text-2xl font-black" style={{ color: 'var(--text-primary)' }}>{s.value}</span>
              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-blue-50 text-blue-600">{s.hint}</span>
            </div>
          </div>
        ))}
      </div>

      {/* 解析失败通知：判错后解析生成持续失败的题（spec §5.4），需人工补题解 */}
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
          <h2 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>解析失败通知</h2>
          {unreadCount > 0 && (
            <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-red-50 text-red-600">{unreadCount} 未读</span>
          )}
        </div>
        {notifications == null ? (
          <div className="px-5 py-8 text-center text-sm text-[var(--text-secondary)]">
            {notifError ? '通知加载失败，请稍后重试' : '加载中…'}
          </div>
        ) : notifications.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-[var(--text-secondary)]">暂无通知</div>
        ) : (
          <ul className="divide-y divide-gray-50">
            {notifications.map((n) => (
              <li key={n.id} className="px-5 py-3.5 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm ${n.isRead ? 'font-medium' : 'font-bold'}`} style={{ color: 'var(--text-primary)' }}>{n.title}</span>
                    {n.questionId != null && (
                      <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-gray-100 text-[var(--text-secondary)]">题目 #{n.questionId}</span>
                    )}
                    {!n.isRead && <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" aria-label="未读" />}
                  </div>
                  <p className="text-[13px] mt-1 text-[var(--text-secondary)] leading-relaxed">{n.content}</p>
                  <p className="text-xs mt-1 text-[var(--text-secondary)]">{new Date(n.createdAt).toLocaleString('zh-CN')}</p>
                </div>
                {!n.isRead && (
                  <button
                    onClick={() => handleMarkRead(n.id)}
                    className="shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-200 text-[var(--text-secondary)] hover:bg-gray-50 transition-colors"
                  >
                    标为已读
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h2 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>最近注册家长</h2>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-[var(--text-secondary)] border-b border-gray-100">
              <th className="px-5 py-3 font-semibold">手机号</th>
              <th className="px-5 py-3 font-semibold">姓名</th>
              <th className="px-5 py-3 font-semibold">学生数</th>
              <th className="px-5 py-3 font-semibold">状态</th>
              <th className="px-5 py-3 font-semibold">注册时间</th>
            </tr>
          </thead>
          <tbody>
            {data.recentParents.map((p) => (
              <tr key={p.id} className="border-b border-gray-50 last:border-0">
                <td className="px-5 py-3" style={{ color: 'var(--text-primary)' }}>{maskPhone(p.phone)}</td>
                <td className="px-5 py-3">{p.name ?? '-'}</td>
                <td className="px-5 py-3">{p.studentCount}</td>
                <td className="px-5 py-3">
                  <span
                    className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded"
                    style={{
                      color: p.isActive ? '#059669' : 'var(--text-secondary)',
                      backgroundColor: p.isActive ? 'rgba(5,150,105,0.08)' : 'rgba(0,0,0,0.04)',
                    }}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${p.isActive ? 'bg-[#059669]' : 'bg-[var(--text-secondary)]'}`}></span>
                    {p.isActive ? '正常' : '停用'}
                  </span>
                </td>
                <td className="px-5 py-3">{new Date(p.createdAt).toLocaleDateString('zh-CN')}</td>
              </tr>
            ))}
            {data.recentParents.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-sm text-[var(--text-secondary)]">暂无家长</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
