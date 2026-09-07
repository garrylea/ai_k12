// apps/web/src/components/business/answer/RunExitGuard.tsx
// 答题页导航守卫：拦截 react-router 路由内返回/跳转（useBlocker），确认后放行。
// 考试页再挂 blockBeforeUnload 拦截刷新/关标签（原生浏览器确认）。
// 开关用页面持有的 ref（guardRef）而非 state：放行路径必须「同步」先置 ref.current=false
// 再 navigate——setState 是异步生效的，navigate 在同一事件处理器里先行触发拦截，
// 会读到旧值导致二次弹确认。
import { useEffect } from 'react';
import { useBlocker } from 'react-router-dom';
import { Modal } from '@/components/base';

interface RunExitGuardProps {
  /** 守卫开关 ref（页面持有，初值 true）：置 false 时放行导航（确认退出后同步赋值再 navigate）。结构化类型而非 RefObject——其 current 含 null，useBlocker 谓词不收 */
  guardRef: { readonly current: boolean };
  /** 拦截刷新/关闭标签页（考试页用；浏览器原生确认，无法自定义文案） */
  blockBeforeUnload?: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export function RunExitGuard({
  guardRef,
  blockBeforeUnload = false,
  title,
  message,
  confirmLabel = '确认离开',
  cancelLabel = '继续答题',
}: RunExitGuardProps) {
  const blocker = useBlocker(() => guardRef.current);

  useEffect(() => {
    if (!blockBeforeUnload) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [blockBeforeUnload]);

  if (blocker.state !== 'blocked') return null;

  return (
    <Modal open onClose={() => blocker.reset()} title={title}>
      <p className="text-sm text-[var(--text-secondary)]">{message}</p>
      <div className="mt-6 flex justify-end gap-3">
        <button
          onClick={() => blocker.reset()}
          className="h-10 px-4 rounded-[var(--radius-button)] border border-[var(--bg-subtle)] text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-base)]"
        >
          {cancelLabel}
        </button>
        <button
          onClick={() => blocker.proceed()}
          className="h-10 px-4 rounded-[var(--radius-button)] bg-[var(--brand-500)] text-sm font-semibold text-white transition-colors hover:bg-[var(--brand-600)]"
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
