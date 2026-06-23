import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { useThemeStore } from '@/store/themeStore';
import { ParentNav } from './ParentNav';
import { Banner } from '@/components/base';

export default function ParentLayout() {
  const { setMode } = useThemeStore();

  useEffect(() => {
    setMode('parent');
  }, [setMode]);

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
            <div className="flex items-center gap-3 text-sm">
              <span className="text-[var(--text-tertiary)]">家长账号 138****1234</span>
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
