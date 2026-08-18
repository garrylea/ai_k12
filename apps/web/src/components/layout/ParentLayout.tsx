import { useCallback, useEffect, useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useThemeStore } from '@/store/themeStore';
import { ParentNav } from './ParentNav';
import { Banner } from '@/components/base';
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

  const hasAlert = true;

  return (
    <div data-theme="parent" className="min-h-screen bg-[var(--bg-base)]">
      <div className="flex h-screen overflow-hidden">
        <ParentNav />

        <div className="flex-1 flex flex-col overflow-hidden">
          {/* 顶部预警 Banner（最高优先级） */}
          {hasAlert && (
            <Banner
              type="danger"
              title="异常预警：检测到孩子今日 3 次闲聊偏离学习"
              description="点击查看详情，建议适时介入"
              action={
                <button className="px-4 py-1.5 bg-white text-[var(--error)] rounded-md text-sm font-semibold hover:bg-gray-50">
                  立即查看
                </button>
              }
            />
          )}

          {/* 顶部栏 */}
          <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-6 shrink-0">
            <div className="flex items-center gap-4">
              <span className="text-sm text-[var(--text-secondary)]">当前查看：</span>
              <div className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 rounded-lg cursor-pointer hover:bg-blue-100">
                <div className="w-7 h-7 rounded-full bg-[var(--brand-500)] flex items-center justify-center text-white text-xs font-bold">明</div>
                <span className="text-sm font-medium text-[var(--text-primary)]">小明（三年级）</span>
                <span className="text-xs text-[var(--text-tertiary)]">▼</span>
              </div>
            </div>
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
