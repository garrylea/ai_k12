import { type ReactNode } from 'react';

interface Props {
  sidebar: ReactNode;
  children: ReactNode;
}

export default function AuxiliaryLayout({ sidebar, children }: Props) {
  return (
    <div
      className="min-h-screen flex items-center justify-center p-4 sm:p-6 lg:p-8"
      data-theme="student-day"
      data-school="junior"
      style={{ backgroundColor: '#F5F5F7' }}
    >
      <div
        className="w-full max-w-6xl h-[85vh] min-h-[600px] flex rounded-3xl overflow-hidden bg-white border border-[#E5E5E5]"
        style={{ boxShadow: '0 2px 12px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04)' }}
      >
        <aside className="w-64 sm:w-72 flex flex-col border-r border-[#E5E5E5] bg-white">
          {sidebar}
        </aside>
        <main className="flex-1 flex flex-col bg-white">
          {children}
        </main>
      </div>
    </div>
  );
}
