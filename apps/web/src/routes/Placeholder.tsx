/**
 * 未开发页面的统一占位。独立成文件：路由表（`routeTable.tsx`）要保持「纯配置、
 * 只导出 routes」，不能同时定义组件（否则触发 react-refresh/only-export-components）。
 */
export function Placeholder({ title }: { title: string }) {
  return (
    <div className="p-8 text-[var(--text-primary)]">
      <h1 className="text-2xl font-bold mb-4">{title}</h1>
      <p className="text-[var(--text-secondary)]">原型占位：此页面正在设计中...</p>
    </div>
  );
}
