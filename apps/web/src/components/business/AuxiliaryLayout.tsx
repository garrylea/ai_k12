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
    <div className="student-theme-container h-screen flex" data-theme={mode} data-school="junior">
      <aside className="w-72 border-r border-[var(--bg-subtle)] bg-[var(--bg-card)] flex flex-col">
        {sidebar}
      </aside>
      <main className="flex-1 flex flex-col bg-[var(--bg-page)]">
        {children}
      </main>
    </div>
  );
}
