/**
 * 「积分稍后到账 + 重试」提示条（两个会话页共用，避免文案/样式走样）。
 *
 * 独立成文件是有意的：`session-completion.ts` 导出的是 hook（非组件），
 * 两者同文件会触发 `react-refresh/only-export-components` 警告。
 */
export function SessionPointsRetryNotice({
  retrying,
  onRetry,
}: {
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-[var(--radius-button)] border border-[var(--bg-subtle)] bg-[var(--learn-card-bg)] px-4 py-2.5"
      role="status"
    >
      <span className="text-sm text-[var(--text-secondary)]">积分稍后到账，可重试</span>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="h-9 shrink-0 rounded-[var(--radius-button)] border border-[var(--brand-500)] px-4 text-sm font-semibold text-[var(--brand-600)] transition-colors hover:bg-[var(--brand-100)] disabled:opacity-60"
      >
        {retrying ? '重试中…' : '重试'}
      </button>
    </div>
  );
}
