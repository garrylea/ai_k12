import { ReactNode, useEffect } from 'react';

interface ConfirmDialogProps {
  open: boolean;
  /** 左上角标题（如「提示：」）。 */
  title?: string;
  message: ReactNode;
  /** false 时仅显示一句提示 + 正下方圆形 X 关闭按钮（轻提示形态，用于练习门禁等）。 */
  showCancel?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 学习阶段浮层（风格与答题弹窗一致）：卡片底色 + 圆角 + 中性文字，不出现品牌色，
 * 避免跳跃颜色打扰学生。两种形态：
 * - 确认形态（showCancel=true）：左上角「提示：」+ 一句提示 + 圆形 X（取消）/ 对勾（确认）图标
 * - 提示形态（showCancel=false）：左上角标题 + 一句提示 + 正下方圆形 X 关闭按钮
 */
export function ConfirmDialog({
  open,
  title,
  message,
  showCancel = true,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-[92vw] max-w-sm bg-[var(--learn-card-bg)] rounded-2xl shadow-xl p-6">
        {title && (
          <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">{title}</h2>
        )}
        <p className="text-sm leading-relaxed text-[var(--text-secondary)] whitespace-pre-line">
          {message}
        </p>
        {showCancel ? (
          <div className="flex justify-center gap-4 mt-6">
            {/* 取消（圆形 X） */}
            <button
              onClick={onCancel}
              className="w-10 h-10 rounded-full border border-[var(--bg-subtle)] bg-[var(--learn-card-bg)] flex items-center justify-center text-[var(--text-tertiary)] hover:bg-[var(--bg-base)] transition-colors"
              title="取消"
              aria-label="取消"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
            {/* 确认（圆形对勾） */}
            <button
              onClick={onConfirm}
              className="w-10 h-10 rounded-full bg-[var(--learn-btn-primary)] hover:bg-[var(--learn-btn-primary-hover)] text-white flex items-center justify-center transition-colors"
              title="确认"
              aria-label="确认"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </button>
          </div>
        ) : (
          <div className="flex justify-center mt-6">
            <button
              onClick={onConfirm}
              className="w-10 h-10 rounded-full border border-[var(--bg-subtle)] bg-[var(--learn-card-bg)] flex items-center justify-center text-[var(--text-tertiary)] hover:bg-[var(--bg-base)] transition-colors"
              title="关闭"
              aria-label="关闭"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
