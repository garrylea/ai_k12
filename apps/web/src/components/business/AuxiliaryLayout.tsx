import { type ReactNode } from 'react';

interface Props {
  /** 左侧栏；不传则整卡只有内容区（做题页复用同一外壳尺寸） */
  sidebar?: ReactNode;
  /**
   * 页面级右栏：渲染在白色大卡**外面**（占真实空间，大卡随之向左让位）。
   * 草稿面板走这里——它属于「桌上的一张草稿纸」，不该被算进作答卡内部。
   */
  sidePanel?: ReactNode;
  /** 页面背景层右上角的悬浮操作（草稿入口图标等）；与 sidePanel 互斥出现 */
  pageAction?: ReactNode;
  children: ReactNode;
}

export default function AuxiliaryLayout({ sidebar, sidePanel, pageAction, children }: Props) {
  const card = (
    <div
      className={`${sidePanel ? 'flex-1 min-w-0' : 'w-full max-w-6xl'} h-[80vh] min-h-[600px] flex rounded-3xl overflow-hidden bg-white border border-[#E5E5E5]`}
      style={{ boxShadow: '0 2px 12px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04)' }}
    >
      {sidebar && (
        <aside className="w-64 sm:w-72 flex flex-col border-r border-[#E5E5E5] bg-white">
          {sidebar}
        </aside>
      )}
      <main className="flex-1 min-w-0 flex flex-col bg-white">{children}</main>
    </div>
  );

  return (
    <div
      className={`relative min-h-screen flex items-center justify-center ${
        sidePanel ? 'p-2 sm:p-3' : 'p-4 sm:p-6 lg:p-8'
      }`}
      data-theme="student-day"
      data-school="junior"
      style={{ backgroundColor: 'var(--bg-page)' }}
    >
      {sidePanel ? (
        // 右栏打开时整行铺满可用宽度（草稿要占大片幅），卡片 flex-1 让出空间；
        // 页面内边距同时收窄，把左右宽度尽量留给作答卡 + 草稿。
        <div className="w-full h-[80vh] min-h-[600px] flex items-stretch">
          {card}
          {sidePanel}
        </div>
      ) : (
        card
      )}
      {pageAction && <div className="absolute top-4 right-4">{pageAction}</div>}
    </div>
  );
}
