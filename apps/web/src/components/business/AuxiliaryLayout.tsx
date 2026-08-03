import { type ReactNode } from 'react';

interface Props {
  sidebar: ReactNode;
  children: ReactNode;
}

export default function AuxiliaryLayout({ sidebar, children }: Props) {
  return (
    <div className="student-theme-container h-screen flex" data-theme="student-day">
      <aside className="w-72 border-r border-[var(--bg-subtle)] bg-[var(--bg-card)] flex flex-col">
        {sidebar}
      </aside>
      <main className="flex-1 flex flex-col bg-[var(--bg-page)]">
        {children}
      </main>
    </div>
  );
}
