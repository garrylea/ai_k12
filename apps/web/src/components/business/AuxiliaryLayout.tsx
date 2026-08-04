import { useEffect, type ReactNode } from 'react';
import { useThemeStore } from '@/store/themeStore';

interface Props {
  sidebar: ReactNode;
  children: ReactNode;
}

export default function AuxiliaryLayout({ sidebar, children }: Props) {
  const { mode, autoToggleNightMode } = useThemeStore();

  useEffect(() => {
    autoToggleNightMode();
    const interval = setInterval(autoToggleNightMode, 60000);
    return () => clearInterval(interval);
  }, [autoToggleNightMode]);

  return (
    <div
      className="student-theme-container min-h-screen flex items-center justify-center p-4 sm:p-6 lg:p-8"
      data-theme={mode}
      data-school="junior"
      style={{ backgroundColor: 'var(--bg-page)' }}
    >
      <div
        className="w-full max-w-6xl h-[85vh] min-h-[600px] flex rounded-3xl overflow-hidden"
        style={{ boxShadow: 'var(--shadow-card)' }}
      >
        <aside className="w-64 sm:w-72 flex flex-col border-r border-[var(--bg-subtle)] bg-[var(--bg-card)]">
          {sidebar}
        </aside>
        <main className="flex-1 flex flex-col bg-[var(--bg-page)]">
          {children}
        </main>
      </div>
    </div>
  );
}
