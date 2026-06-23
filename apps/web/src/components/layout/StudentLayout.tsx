import { useEffect } from 'react';
import { Outlet, Link } from 'react-router-dom';
import { useThemeStore } from '@/store/themeStore';
import { StudentNav } from './StudentNav';

export default function StudentLayout() {
  const { mode, setMode, autoToggleNightMode } = useThemeStore();

  useEffect(() => {
    autoToggleNightMode();
    const interval = setInterval(autoToggleNightMode, 60000);
    return () => clearInterval(interval);
  }, [autoToggleNightMode]);

  return (
    <div
      className="student-theme-container"
      data-theme={mode}
      data-school="junior"
    >
      <div className="flex h-screen overflow-hidden">
        <StudentNav />

        <div className="flex-1 flex flex-col overflow-hidden">
          {/* 顶部全局栏 */}
          <header className="h-16 bg-[var(--bg-card)] border-b border-[var(--bg-subtle)] flex items-center justify-between px-6 shrink-0">
            <div className="flex items-center gap-4">
              <span className="text-sm font-medium text-[var(--text-secondary)]">三年级 · 数学 人教版</span>
              <Link to="/student/subjects" className="text-xs text-[var(--info)] hover:underline">
                切换学科
              </Link>
            </div>
            <div className="flex items-center gap-4">
              {/* 护眼模式切换 */}
              <div className="flex items-center gap-1 bg-[var(--bg-subtle)] rounded-[var(--radius-pill)] p-1">
                {(['student-day', 'student-night'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={`px-3 py-1 text-xs rounded-[var(--radius-pill)] transition-all ${
                      mode === m
                        ? 'bg-[var(--brand-500)] text-white'
                        : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    {m === 'student-day' ? '日间' : '夜间'}
                  </button>
                ))}
              </div>
            </div>
          </header>

          {/* 页面内容 */}
          <main className="flex-1 overflow-y-auto bg-[var(--bg-base)]">
            <div className="student-theme-container h-full">
              <Outlet />
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
