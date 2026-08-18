import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { useThemeStore } from '@/store/themeStore';
import { AdminNav } from './AdminNav';

/** 管理员中枢壳：左侧栏导航 + 右侧内容区（商务蓝 parent 主题）。 */
export default function AdminLayout() {
  const { setMode } = useThemeStore();
  useEffect(() => { setMode('parent'); }, [setMode]);

  return (
    <div data-theme="parent" className="min-h-screen bg-[var(--bg-base)]">
      <div className="flex h-screen overflow-hidden">
        <AdminNav />
        <main className="flex-1 overflow-y-auto bg-[var(--bg-base)] p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
