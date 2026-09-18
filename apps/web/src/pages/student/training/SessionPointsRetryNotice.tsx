/**
 * 会话完成发分失败时的提示条（两个会话页共用，避免文案/样式走样）。
 *
 * 两种性质**不能混为一谈**（否则提示条会撒谎）：
 * - `retry`（缺省）：网络抖动 / 5xx，服务端会话留在 `in_progress`，重试会补发且只补一次；
 * - `unrecoverable`：客户端 4xx（token 失效 / 会话已被删除 / 参数错），重试必然失败，
 *   只给诚实说明、**不出重试按钮**。
 *
 * 独立成文件是有意的：`session-completion.ts` 导出的是 hook（非组件），
 * 两者同文件会触发 `react-refresh/only-export-components` 警告。
 */
export function SessionPointsRetryNotice({
  retrying,
  onRetry,
  variant = 'retry',
}: {
  retrying: boolean;
  onRetry: () => void;
  variant?: 'retry' | 'unrecoverable';
}) {
  if (variant === 'unrecoverable') {
    return (
      <div
        className="flex items-center rounded-[var(--radius-button)] border border-[var(--bg-subtle)] bg-[var(--learn-card-bg)] px-4 py-2.5"
        role="status"
      >
        <span className="text-sm text-[var(--text-secondary)]">
          本次积分未能到账，请联系家长或稍后查看积分明细
        </span>
      </div>
    );
  }

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
