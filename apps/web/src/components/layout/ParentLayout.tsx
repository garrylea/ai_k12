import { useCallback, useEffect, useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useThemeStore } from '@/store/themeStore';
import { ParentNav } from './ParentNav';
import { StudentSwitcher } from './StudentSwitcher';
import AlertBanner from '@/components/business/AlertBanner';
import { getUnreadMessageCount } from '@/services/api';

export default function ParentLayout() {
  const { setMode } = useThemeStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [unreadCount, setUnreadCount] = useState(0);

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

  return (
    <div data-theme="parent" className="min-h-screen bg-[var(--bg-base)]">
      <div className="flex h-screen overflow-hidden">
        <ParentNav />

        <div className="flex-1 flex flex-col overflow-hidden">
          {/* 顶部预警 Banner（最高优先级）：全部孩子的未读预警，30s 轮询，点击即已读 */}
          <AlertBanner />

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
