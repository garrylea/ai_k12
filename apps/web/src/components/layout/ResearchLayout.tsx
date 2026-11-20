import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { useThemeStore } from '@/store/themeStore';
import { ResearchNav } from './ResearchNav';

/** 教研空间外壳：左侧栏导航 + 右侧内容区（沿用管理端日间 token）。 */
export default function ResearchLayout() {
  const { setMode } = useThemeStore();
  useEffect(() => { setMode('parent'); }, [setMode]);

  return (
    <div data-theme="parent" className="min-h-screen bg-[var(--bg-base)]">
      <div className="flex h-screen overflow-hidden">
        <ResearchNav />
        <main className="flex-1 overflow-y-auto bg-[var(--bg-base)] p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
