// apps/web/src/components/business/answer/RunExitGuard.tsx
// 答题页导航守卫：拦截 react-router 路由内返回/跳转（useBlocker），确认后放行。
// 考试页再挂 blockBeforeUnload 拦截刷新/关标签（原生浏览器确认）。
// 注意：组件内部 useBlocker 必须无条件调用，所以「禁用」通过 enabled ref 实现——
// X 确认弹窗先 setEnabled(false) 再 navigate，避免二次拦截。
import { useEffect, useRef } from 'react';
import { useBlocker } from 'react-router-dom';
import { Modal } from '@/components/base';

interface RunExitGuardProps {
  /** false 时放行导航（父层确认退出后先置 false 再 navigate） */
  enabled: boolean;
  /** 拦截刷新/关闭标签页（考试页用；浏览器原生确认，无法自定义文案） */
  blockBeforeUnload?: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export function RunExitGuard({
  enabled,
  blockBeforeUnload = false,
  title,
  message,
  confirmLabel = '确认离开',
  cancelLabel = '继续答题',
}: RunExitGuardProps) {
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const blocker = useBlocker(() => enabledRef.current);

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
