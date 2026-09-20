import { useCallback, useEffect, useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useThemeStore } from '@/store/themeStore';
import { useParentStudentStore } from '@/store/parentStudentStore';
import { ParentNav } from './ParentNav';
import { StudentSwitcher } from './StudentSwitcher';
import { Banner } from '@/components/base';
import { getUnreadMessageCount, getParentAlerts, type ParentAlertItem } from '@/services/api';

export default function ParentLayout() {
  const { setMode } = useThemeStore();
  const navigate = useNavigate();
  const location = useLocation();
  const studentId = useParentStudentStore((s) => s.studentId);
  const [unreadCount, setUnreadCount] = useState(0);
  /**
   * 当前选中孩子的「最新一条未读 warning/critical 预警」（spec §5.1）。
   *
   * 派生状态**带 `studentId` 归属**：切孩子时本组件不重挂载，若只存 item，
   * 请求在途期间会短暂拿 A 孩子的预警渲染给 B 孩子看。存 `{ studentId, item }`
   * 后，渲染前比对归属即可杜绝串号（与 `ParentErrorsPage` 同一纪律）。
   */
  const [alert, setAlert] = useState<{ studentId: number; item: ParentAlertItem } | null>(null);

  useEffect(() => {
    setMode('parent');
  }, [setMode]);

  // 路由切换时刷新未读数（读消息后返回本页会自动更新）。
  const loadUnread = useCallback(() => {
    getUnreadMessageCount()
      .then(setUnreadCount)
      .catch(() => {
        /* 未读数拉取失败不打扰，保持上次值 */
      });
  }, []);

  useEffect(() => {
    loadUnread();
  }, [loadUnread, location.pathname]);

  // Banner 与未读数同一刷新时机（`location.pathname` 变化时重拉）。
  useEffect(() => {
    if (studentId === null) {
      // 没选孩子 → 不请求、不渲染（spec §5.1）
      setAlert(null);
      return;
    }
    let cancelled = false;
    getParentAlerts({ studentId, unreadOnly: true, pageSize: 1 })
      .then((res) => {
        if (cancelled) return;
        const first = res.items[0];
        setAlert(first ? { studentId, item: first } : null);
      })
      .catch(() => {
        if (cancelled) return;
        // 失败静默：不渲染、不占位、不抖动（与未读数拉取失败一致）
        setAlert(null);
      });
    return () => {
      cancelled = true;
    };
  }, [studentId, location.pathname]);

  // 只有「当前孩子」的 warning/critical 才渲染；info 只进列表页（spec §3.5）
  const bannerAlert =
    alert &&
    alert.studentId === studentId &&
    (alert.item.level === 'warning' || alert.item.level === 'critical')
      ? alert.item
      : null;

  return (
    <div data-theme="parent" className="min-h-screen bg-[var(--bg-base)]">
      <div className="flex h-screen overflow-hidden">
        <ParentNav />

        <div className="flex-1 flex flex-col overflow-hidden">
          {/* 顶部预警 Banner（最高优先级）：当前孩子的最新未读 warning/critical */}
          {bannerAlert && (
            <Banner
              type="danger"
              title={bannerAlert.message}
              description="点击查看详情，建议适时介入"
              action={
                <button
                  type="button"
                  onClick={() => navigate('/parent/alerts')}
                  className="px-4 py-1.5 bg-white text-[var(--error)] rounded-md text-sm font-semibold hover:bg-gray-50"
                >
                  立即查看
                </button>
              }
            />
          )}

          {/* 顶部栏 */}
          <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-6 shrink-0">
            {/* 「当前查看哪个孩子」的锚点：列表拉取与回落逻辑都在组件里，本层不再拉第二次 */}
            <StudentSwitcher />
            <div className="flex items-center gap-3">
              <span className="text-sm text-[var(--text-tertiary)]">家长端 · 监管空间</span>
              <button
                type="button"
                onClick={() => navigate('/parent/messages')}
                className="relative w-9 h-9 flex items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)] transition-colors"
                title="消息中心"
                aria-label="消息中心"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
                  <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                </svg>
                {unreadCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-[var(--error)] text-white text-[10px] font-bold flex items-center justify-center">
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </span>
                )}
              </button>
            </div>
          </header>

          <main className="flex-1 overflow-y-auto bg-[var(--bg-base)] p-6">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
